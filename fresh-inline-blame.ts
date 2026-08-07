import {
  blameArguments,
  displayAuthor,
  formatBlameLabel,
  isCommittedHash,
  lineAnchor,
  parseBlamePorcelain,
  showArguments,
} from "./src/core";

type BlameInfo = NonNullable<ReturnType<typeof parseBlamePorcelain>>;

interface LineSnapshot {
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  content: string;
}

const editor = getEditor();

const PLUGIN_VERSION = "0.1.0";
const VIRTUAL_TEXT_ID = "fresh-inline-blame:current";
const OPEN_COMMIT_ICON = "↗";
const CACHE_TTL_MS = 5 * 60 * 1000;
const NEGATIVE_CACHE_TTL_MS = 2 * 1000;
const PATH_FAILURE_TTL_MS = 10 * 1000;
const MAX_CACHE_FILES = 16;
const MAX_CACHE_LINES_PER_FILE = 128;
const MAX_LINE_SNAPSHOTS = 512;
const MAX_LINE_SNAPSHOT_BUFFERS = 16;
const LINE_REFRESH_GRACE_MS = 16;
const DIFF_POLL_MS = 100;
const DIFF_CACHE_VERSION = "visible-v1";

interface PluginConfig {
  enabled: boolean;
  debounceMs: number;
  debug: boolean;
}

interface ScheduledTarget {
  bufferId: number;
  line: number;
  key: string;
  generation: number;
  dueAt: number;
}

interface CachedBlame {
  value: BlameInfo | null;
  expiresAt: number;
}

interface BufferLineSnapshots {
  epoch: number;
  lines: Map<number, LineSnapshot>;
}

interface RenderedBlame {
  bufferId: number;
  line: number;
  lineByteLength: number;
  arrowTextColumn: number | null;
  arrowWidth: number;
  renderedLineWidth: number | null;
  commit: string;
  cwd: string;
  author: string;
}

interface SnapshotWait {
  target: ScheduledTarget;
  graceActive: boolean;
}

interface DiffView {
  bufferId: number;
  splitId: number;
}

const configuredEnabled = editor.defineConfigBoolean("enabled", {
  default: true,
  description: "Show Git blame for the active line",
});
const configuredDebounceMs = editor.defineConfigInteger("debounceMs", {
  default: 100,
  minimum: 0,
  maximum: 1000,
  description: "Delay before blaming a newly selected line",
});
const configuredDebug = editor.defineConfigBoolean("debug", {
  default: false,
  description: "Write inline-blame diagnostics to the Fresh log",
});

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readConfig(): PluginConfig {
  const raw = asRecord(editor.getPluginConfig());
  const debounce =
    typeof raw.debounceMs === "number" && Number.isFinite(raw.debounceMs)
      ? Math.max(0, Math.min(1000, Math.floor(raw.debounceMs)))
      : configuredDebounceMs;
  return {
    enabled:
      typeof raw.enabled === "boolean" ? raw.enabled : configuredEnabled,
    debounceMs: debounce,
    debug: typeof raw.debug === "boolean" ? raw.debug : configuredDebug,
  };
}

let config = readConfig();

function debug(message: string): void {
  if (config.debug) editor.debug(`fresh-inline-blame: ${message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lineContent(content: string): string {
  if (content.endsWith("\r\n")) return content.slice(0, -2);
  if (content.endsWith("\n")) return content.slice(0, -1);
  return content;
}

function configuredTabSize(language: string): number {
  const rawConfig = asRecord(editor.getConfig());
  const editorConfig = asRecord(rawConfig.editor);
  const languageConfig = asRecord(asRecord(rawConfig.languages)[language]);
  const configured =
    typeof languageConfig.tab_size === "number"
      ? languageConfig.tab_size
      : editorConfig.tab_size;
  return typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
    ? Math.floor(configured)
    : 4;
}

function sourceDisplayWidth(source: string, tabSize: number): number | null {
  // Newlines are already stripped above. Other control characters do not
  // have a stable screen width, but tabs do: Fresh expands each one to the
  // next configured tab stop.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source)) {
    return null;
  }

  let width = 0;
  const segments = source.split("\t");
  for (let index = 0; index < segments.length; index += 1) {
    const segmentWidth = editor.stringWidth(segments[index]);
    if (!Number.isInteger(segmentWidth) || segmentWidth < 0) return null;
    width += segmentWidth;
    if (index + 1 < segments.length) {
      width += tabSize - (width % tabSize);
    }
  }
  return width;
}

function clickGeometry(
  snapshot: LineSnapshot,
  label: string,
  trailingPadding: boolean,
  language: string,
): Pick<
  RenderedBlame,
  "arrowTextColumn" | "arrowWidth" | "renderedLineWidth"
> {
  const source = lineContent(snapshot.content);
  const arrowWidth = editor.stringWidth(OPEN_COMMIT_ICON);
  if (
    !label.endsWith(OPEN_COMMIT_ICON) ||
    !Number.isInteger(arrowWidth) ||
    arrowWidth <= 0
  ) {
    return {
      arrowTextColumn: null,
      arrowWidth: 1,
      renderedLineWidth: null,
    };
  }

  const sourceWidth = sourceDisplayWidth(
    source,
    configuredTabSize(language),
  );
  const labelPrefixWidth = editor.stringWidth(
    label.slice(0, -OPEN_COMMIT_ICON.length),
  );
  const labelWidth = editor.stringWidth(label);
  if (
    sourceWidth === null ||
    !Number.isInteger(labelPrefixWidth) ||
    !Number.isInteger(labelWidth) ||
    sourceWidth < 0 ||
    labelPrefixWidth < 0 ||
    labelWidth < arrowWidth
  ) {
    return {
      arrowTextColumn: null,
      arrowWidth,
      renderedLineWidth: null,
    };
  }

  // Fresh adds one leading cell around inline virtual text, and adds a
  // trailing cell when the hint is inserted before a newline.
  return {
    arrowTextColumn: sourceWidth + 1 + labelPrefixWidth,
    arrowWidth,
    renderedLineWidth:
      sourceWidth + 1 + labelWidth + (trailingPadding ? 1 : 0),
  };
}

const blameCache = new Map<string, Map<number, CachedBlame>>();
const unavailablePaths = new Map<string, number>();
const lineSnapshots = new Map<number, BufferLineSnapshots>();
const diffViews = new Map<string, DiffView>();
const diffBufferHashes = new Map<number, string>();
const diffSpawns = new Map<string, ProcessHandle<SpawnResult>>();
const diffOpenings = new Map<string, Promise<DiffView | null>>();
const diffShowOperations = new Map<string, Promise<void>>();
let diffDirectoryReady = false;

function blameFromCache(path: string, line: number): CachedBlame | null {
  const fileCache = blameCache.get(path);
  const cached = fileCache?.get(line);
  if (fileCache === undefined || cached === undefined) return null;
  if (cached.expiresAt <= Date.now()) {
    fileCache.delete(line);
    if (fileCache.size === 0) blameCache.delete(path);
    return null;
  }

  fileCache.delete(line);
  fileCache.set(line, cached);
  blameCache.delete(path);
  blameCache.set(path, fileCache);
  return cached;
}

function cacheBlame(
  path: string,
  line: number,
  value: BlameInfo | null,
  ttlMs = CACHE_TTL_MS,
): void {
  let fileCache = blameCache.get(path);
  if (fileCache === undefined) {
    fileCache = new Map<number, CachedBlame>();
  } else {
    blameCache.delete(path);
  }

  fileCache.delete(line);
  fileCache.set(line, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
  while (fileCache.size > MAX_CACHE_LINES_PER_FILE) {
    const oldestLine = fileCache.keys().next().value as number | undefined;
    if (oldestLine === undefined) break;
    fileCache.delete(oldestLine);
  }
  blameCache.set(path, fileCache);

  while (blameCache.size > MAX_CACHE_FILES) {
    const oldestPath = blameCache.keys().next().value as string | undefined;
    if (oldestPath === undefined) break;
    blameCache.delete(oldestPath);
  }
}

function pathTemporarilyUnavailable(path: string): boolean {
  const expiresAt = unavailablePaths.get(path);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    unavailablePaths.delete(path);
    return false;
  }
  unavailablePaths.delete(path);
  unavailablePaths.set(path, expiresAt);
  return true;
}

function cacheUnavailablePath(path: string): void {
  unavailablePaths.delete(path);
  unavailablePaths.set(path, Date.now() + PATH_FAILURE_TTL_MS);
  while (unavailablePaths.size > MAX_CACHE_FILES) {
    const oldestPath = unavailablePaths.keys().next().value as
      | string
      | undefined;
    if (oldestPath === undefined) break;
    unavailablePaths.delete(oldestPath);
  }
}

function invalidatePath(path: string): void {
  if (!path) return;
  blameCache.delete(path);
  unavailablePaths.delete(path);
}

function lineSnapshotFor(bufferId: number, line: number): LineSnapshot | null {
  const buffer = lineSnapshots.get(bufferId);
  const snapshot = buffer?.lines.get(line);
  if (buffer === undefined || snapshot === undefined) return null;
  buffer.lines.delete(line);
  buffer.lines.set(line, snapshot);
  lineSnapshots.delete(bufferId);
  lineSnapshots.set(bufferId, buffer);
  return snapshot;
}

function cacheLineSnapshots(data: LinesChangedHookArgs): void {
  let buffer = lineSnapshots.get(data.buffer_id);
  if (buffer === undefined || buffer.epoch !== data.epoch) {
    buffer = { epoch: data.epoch, lines: new Map<number, LineSnapshot>() };
  } else {
    lineSnapshots.delete(data.buffer_id);
  }

  for (const line of data.lines) {
    buffer.lines.delete(line.line_number);
    buffer.lines.set(line.line_number, {
      lineNumber: line.line_number,
      byteStart: line.byte_start,
      byteEnd: line.byte_end,
      content: line.content,
    });
  }
  while (buffer.lines.size > MAX_LINE_SNAPSHOTS) {
    const oldestLine = buffer.lines.keys().next().value as number | undefined;
    if (oldestLine === undefined) break;
    buffer.lines.delete(oldestLine);
  }
  lineSnapshots.set(data.buffer_id, buffer);

  while (lineSnapshots.size > MAX_LINE_SNAPSHOT_BUFFERS) {
    const oldestBuffer = lineSnapshots.keys().next().value as number | undefined;
    if (oldestBuffer === undefined) break;
    lineSnapshots.delete(oldestBuffer);
  }
}

let generation = 0;
let requestedKey: string | null = null;
let pendingTarget: ScheduledTarget | null = null;
let schedulerRunning = false;
let activeBlameHandle: ProcessHandle<SpawnResult> | null = null;
let renderedBlame: RenderedBlame | null = null;
let snapshotWait: SnapshotWait | null = null;

function targetKey(bufferId: number, line: number): string {
  return `${bufferId}:${line}`;
}

function clearRenderedBlame(): void {
  const rendered = renderedBlame;
  renderedBlame = null;
  if (rendered !== null) {
    editor.removeVirtualText(rendered.bufferId, VIRTUAL_TEXT_ID);
  }
}

function cancelBlameProcess(): void {
  const handle = activeBlameHandle;
  activeBlameHandle = null;
  if (handle !== null) cancelProcess(handle, "cancel failed");
}

function cancelProcess(
  handle: ProcessHandle<SpawnResult>,
  failureMessage: string,
): void {
  if (typeof handle.kill !== "function") return;
  try {
    // Fresh 0.4.6 returns a synchronous boolean for spawnProcess.kill(),
    // despite declaring Promise<boolean>. Newer/fixed runtimes may return
    // the declared promise, so support both without allocating on the hot
    // synchronous cursor-movement path.
    const cancellation = handle.kill();
    if (typeof cancellation !== "boolean") {
      void cancellation.catch((error: unknown) => {
        debug(`${failureMessage}: ${errorMessage(error)}`);
      });
    }
  } catch (error) {
    debug(`${failureMessage}: ${errorMessage(error)}`);
  }
}

function cancelRequests(): void {
  generation += 1;
  requestedKey = null;
  pendingTarget = null;
  snapshotWait = null;
  cancelBlameProcess();
  clearRenderedBlame();
}

function targetIsCurrent(target: ScheduledTarget): boolean {
  if (
    target.generation !== generation ||
    requestedKey !== target.key ||
    !config.enabled ||
    editor.workspaceTrustLevel() !== "trusted" ||
    editor.getActiveBufferId() !== target.bufferId
  ) {
    return false;
  }
  const cursor = editor.getPrimaryCursor();
  return cursor?.line === target.line;
}

function requestLine(
  bufferId: number,
  line: number,
  force = false,
  delayMs = config.debounceMs,
): void {
  if (
    !config.enabled ||
    editor.workspaceTrustLevel() !== "trusted" ||
    bufferId <= 0 ||
    line < 0 ||
    diffBufferHashes.has(bufferId)
  ) {
    cancelRequests();
    return;
  }

  const key = targetKey(bufferId, line);
  if (!force && requestedKey === key) return;

  generation += 1;
  requestedKey = key;
  snapshotWait = null;
  pendingTarget = {
    bufferId,
    line,
    key,
    generation,
    dueAt: Date.now() + delayMs,
  };
  cancelBlameProcess();
  clearRenderedBlame();

  if (lineSnapshotFor(bufferId, line) === null) {
    editor.refreshLines(bufferId);
  }
  startScheduler();
}

function requestActiveLine(force = false): void {
  if (!config.enabled || editor.workspaceTrustLevel() !== "trusted") {
    cancelRequests();
    return;
  }

  const bufferId = editor.getActiveBufferId();
  const info = bufferId > 0 ? editor.getBufferInfo(bufferId) : null;
  const cursor = editor.getPrimaryCursor();
  if (
    info === null ||
    cursor?.line === null ||
    cursor?.line === undefined ||
    info.path.length === 0 ||
    info.modified ||
    info.is_virtual ||
    info.is_terminal ||
    diffBufferHashes.has(bufferId)
  ) {
    cancelRequests();
    return;
  }
  requestLine(bufferId, cursor.line, force);
}

async function blameForTarget(
  target: ScheduledTarget,
  path: string,
): Promise<BlameInfo | null> {
  const cached = blameFromCache(path, target.line);
  if (cached !== null) return cached.value;
  if (pathTemporarilyUnavailable(path)) return null;

  const cwd = editor.pathDirname(path);
  const fileName = editor.pathBasename(path);
  if (!cwd || !fileName) return null;

  const startedAt = Date.now();
  const handle = editor.spawnProcess(
    "git",
    blameArguments(target.line, fileName),
    cwd,
  );
  activeBlameHandle = handle;

  let result: SpawnResult;
  try {
    result = await handle.result;
  } catch (error) {
    if (targetIsCurrent(target)) {
      cacheUnavailablePath(path);
      debug(`git blame failed: ${errorMessage(error)}`);
    }
    return null;
  } finally {
    if (activeBlameHandle === handle) activeBlameHandle = null;
  }

  if (!targetIsCurrent(target)) return null;
  if (result.exit_code !== 0) {
    cacheUnavailablePath(path);
    debug(`git blame exited ${result.exit_code}: ${result.stderr.trim()}`);
    return null;
  }

  const parsed = parseBlamePorcelain(result.stdout);
  if (parsed === null) {
    cacheUnavailablePath(path);
    return null;
  }
  if (!isCommittedHash(parsed.commit)) {
    cacheBlame(path, target.line, null, NEGATIVE_CACHE_TTL_MS);
    return null;
  }
  cacheBlame(path, target.line, parsed);
  debug(
    `blamed ${fileName}:${target.line + 1} in ${Date.now() - startedAt}ms`,
  );
  return parsed;
}

async function renderTarget(
  target: ScheduledTarget,
  path: string,
  blame: BlameInfo,
  language: string,
): Promise<void> {
  let snapshot = lineSnapshotFor(target.bufferId, target.line);
  if (snapshot === null) {
    snapshotWait = { target, graceActive: true };
    editor.refreshLines(target.bufferId);
    await editor.delay(LINE_REFRESH_GRACE_MS);
    if (snapshotWait?.target === target) snapshotWait.graceActive = false;
    if (!targetIsCurrent(target)) {
      if (snapshotWait?.target === target) snapshotWait = null;
      return;
    }
    snapshot = lineSnapshotFor(target.bufferId, target.line);
  }
  if (snapshot === null) {
    debug(`no rendered line snapshot for line ${target.line + 1}`);
    return;
  }
  if (snapshotWait?.target === target) snapshotWait = null;

  const placement = lineAnchor(snapshot);
  if (placement === null || !targetIsCurrent(target)) return;
  const cwd = editor.pathDirname(path);
  if (!cwd) return;
  const label = formatBlameLabel(blame);

  const added = editor.addVirtualTextStyled(
    target.bufferId,
    VIRTUAL_TEXT_ID,
    placement.anchor,
    label,
    { fg: "editor.line_number_fg" },
    placement.before,
  );
  if (!added) return;
  if (!targetIsCurrent(target)) {
    editor.removeVirtualText(target.bufferId, VIRTUAL_TEXT_ID);
    return;
  }

  renderedBlame = {
    bufferId: target.bufferId,
    line: target.line,
    lineByteLength: placement.lineByteLength,
    ...clickGeometry(snapshot, label, placement.before, language),
    commit: blame.commit,
    cwd,
    author: displayAuthor(blame),
  };
}

async function refreshTarget(target: ScheduledTarget): Promise<void> {
  if (!targetIsCurrent(target)) return;
  const info = editor.getBufferInfo(target.bufferId);
  if (
    info === null ||
    info.modified ||
    info.is_virtual ||
    info.is_terminal ||
    info.path.length === 0 ||
    diffBufferHashes.has(target.bufferId)
  ) {
    return;
  }

  const blame = await blameForTarget(target, info.path);
  if (blame === null || !targetIsCurrent(target)) return;
  await renderTarget(target, info.path, blame, info.language);
}

async function drainScheduledTargets(): Promise<void> {
  while (pendingTarget !== null) {
    const target = pendingTarget;
    const remaining = target.dueAt - Date.now();
    if (remaining > 0) await editor.delay(remaining);
    if (pendingTarget !== target) continue;

    pendingTarget = null;
    await refreshTarget(target);
  }
}

function startScheduler(): void {
  if (schedulerRunning) return;
  schedulerRunning = true;
  void drainScheduledTargets()
    .catch((error: unknown) => {
      debug(`scheduler failed: ${errorMessage(error)}`);
    })
    .finally(() => {
      schedulerRunning = false;
      if (pendingTarget !== null) startScheduler();
    });
}

function diffDirectory(): string {
  // Streaming buffers created by older plugin versions stay hidden from
  // Fresh's tab strip for their lifetime. A versioned path guarantees the
  // normal file open below cannot accidentally reuse one of those buffers.
  return `${editor.getDataDir()}/fresh-inline-blame/${DIFF_CACHE_VERSION}`;
}

function diffPath(commit: string): string {
  return `${diffDirectory()}/${commit}.diff`;
}

function diffDonePath(commit: string): string {
  return `${diffPath(commit)}.done`;
}

function ensureDiffDirectory(): boolean {
  if (diffDirectoryReady) return true;
  diffDirectoryReady = editor.createDir(editor.localPath(diffDirectory()));
  return diffDirectoryReady;
}

function diffIsComplete(commit: string): boolean {
  return (
    editor.fileExists(editor.localPath(diffPath(commit))) &&
    editor.fileExists(editor.localPath(diffDonePath(commit)))
  );
}

function startDiffProcess(
  commit: string,
  cwd: string,
): ProcessHandle<SpawnResult> {
  return editor.spawnProcess(
    "git",
    showArguments(commit),
    cwd,
    diffPath(commit),
  );
}

function stopDiffProcess(commit: string): void {
  const handle = diffSpawns.get(commit);
  if (handle === undefined) return;
  diffSpawns.delete(commit);
  cancelProcess(handle, "git show cancel failed");
}

function stopAllDiffProcesses(): void {
  for (const commit of Array.from(diffSpawns.keys())) stopDiffProcess(commit);
}

async function pollDiff(
  commit: string,
  bufferId: number,
  handle: ProcessHandle<SpawnResult>,
): Promise<void> {
  const completion: { settled: boolean; exitCode: number | null } = {
    settled: false,
    exitCode: null,
  };
  void handle.result.then(
    (value) => {
      completion.exitCode = value.exit_code;
      completion.settled = true;
    },
    () => {
      completion.settled = true;
    },
  );

  while (!completion.settled) {
    await editor.delay(DIFF_POLL_MS);
    if (diffViews.get(commit)?.bufferId === bufferId) {
      await editor.refreshBufferFromDisk(bufferId);
    }
  }
  if (diffViews.get(commit)?.bufferId === bufferId) {
    await editor.refreshBufferFromDisk(bufferId);
  }
  const stillOwned = diffSpawns.get(commit) === handle;
  if (stillOwned) diffSpawns.delete(commit);
  if (!stillOwned) return;

  if (completion.exitCode === 0) {
    editor.writeFile(editor.localPath(diffDonePath(commit)), "");
  } else if (completion.exitCode !== null) {
    editor.setStatus(
      `Inline Blame: git show failed (exit ${completion.exitCode})`,
    );
  }
}

async function createDiffView(
  commit: string,
  cwd: string,
): Promise<DiffView | null> {
  if (!ensureDiffDirectory()) return null;
  const existing = diffViews.get(commit);
  if (existing !== undefined) {
    if (diffSpawns.has(commit) || diffIsComplete(commit)) return existing;
    if (!editor.writeFile(editor.localPath(diffPath(commit)), "")) return null;
    const handle = startDiffProcess(commit, cwd);
    diffSpawns.set(commit, handle);
    void pollDiff(commit, existing.bufferId, handle);
    return existing;
  }

  const generate = !diffIsComplete(commit);
  if (
    generate &&
    !editor.writeFile(editor.localPath(diffPath(commit)), "")
  ) {
    return null;
  }

  const split = await editor.splitWindow({
    direction: "horizontal",
    place: "after",
    ratio: 0.5,
    file: diffPath(commit),
  });
  const view = { bufferId: split.bufferId, splitId: split.splitId };
  diffViews.set(commit, view);
  diffBufferHashes.set(split.bufferId, commit);
  editor.markFileReadOnly(diffPath(commit));
  editor.setIndentationGuide(split.bufferId, false);
  if (!editor.closeOtherBuffersInSplit(split.bufferId, split.splitId)) {
    debug(`could not isolate commit diff split ${split.splitId}`);
  }

  if (generate) {
    const handle = startDiffProcess(commit, cwd);
    diffSpawns.set(commit, handle);
    void pollDiff(commit, split.bufferId, handle);
  }
  return view;
}

async function ensureDiffView(
  commit: string,
  cwd: string,
): Promise<DiffView | null> {
  if (editor.workspaceTrustLevel() !== "trusted") return null;
  const existing = diffOpenings.get(commit);
  if (existing !== undefined) return existing;

  const opening = createDiffView(commit, cwd);
  diffOpenings.set(commit, opening);
  try {
    return await opening;
  } finally {
    if (diffOpenings.get(commit) === opening) diffOpenings.delete(commit);
  }
}

async function runShowDiff(rendered: RenderedBlame): Promise<void> {
  if (!config.enabled) return;
  if (editor.workspaceTrustLevel() !== "trusted") {
    editor.setStatus("Inline Blame: commit diffs require a trusted workspace");
    return;
  }
  editor.setStatus(`Inline Blame: opening ${rendered.commit.slice(0, 12)}…`);
  let view: DiffView | null;
  try {
    view = await ensureDiffView(rendered.commit, rendered.cwd);
  } catch (error) {
    debug(`could not open commit diff: ${errorMessage(error)}`);
    editor.setStatus("Inline Blame: could not open commit diff");
    return;
  }
  if (view === null) {
    editor.setStatus("Inline Blame: could not open commit diff");
    return;
  }
  if (!config.enabled || editor.workspaceTrustLevel() !== "trusted") return;

  editor.focusSplit(view.splitId);
  editor.setStatus(
    `Inline Blame: ${rendered.commit.slice(0, 12)} by ${rendered.author}`,
  );
}

function showDiff(rendered: RenderedBlame): Promise<void> {
  const existing = diffShowOperations.get(rendered.commit);
  if (existing !== undefined) return existing;

  const operation = runShowDiff(rendered);
  diffShowOperations.set(rendered.commit, operation);
  void operation.then(
    () => {
      if (diffShowOperations.get(rendered.commit) === operation) {
        diffShowOperations.delete(rendered.commit);
      }
    },
    () => {
      if (diffShowOperations.get(rendered.commit) === operation) {
        diffShowOperations.delete(rendered.commit);
      }
    },
  );
  return operation;
}

function invalidateBuffer(bufferId: number): void {
  const path = editor.getBufferPath(bufferId);
  invalidatePath(path);
  lineSnapshots.delete(bufferId);
  if (
    editor.getActiveBufferId() === bufferId ||
    renderedBlame?.bufferId === bufferId
  ) {
    cancelRequests();
  }
}

registerHandler(
  "inlineBlameOnCursorMoved",
  (data: {
    buffer_id: number;
  }): void => {
    if (data.buffer_id !== editor.getActiveBufferId()) return;
    const cursor = editor.getPrimaryCursor();
    if (cursor?.line === null || cursor?.line === undefined) return;
    requestLine(data.buffer_id, cursor.line);
  },
);

registerHandler(
  "inlineBlameOnBufferActivated",
  (): void => {
    requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameOnBufferDeactivated",
  (data: { buffer_id: number }): void => {
    if (
      renderedBlame?.bufferId === data.buffer_id ||
      requestedKey?.startsWith(`${data.buffer_id}:`)
    ) {
      cancelRequests();
    }
  },
);

registerHandler(
  "inlineBlameOnBufferClosed",
  (data: { buffer_id: number }): void => {
    lineSnapshots.delete(data.buffer_id);
    if (
      renderedBlame?.bufferId === data.buffer_id ||
      requestedKey?.startsWith(`${data.buffer_id}:`)
    ) {
      cancelRequests();
    }
    const commit = diffBufferHashes.get(data.buffer_id);
    if (commit !== undefined) {
      diffBufferHashes.delete(data.buffer_id);
      if (diffViews.get(commit)?.bufferId === data.buffer_id) {
        diffViews.delete(commit);
      }
      stopDiffProcess(commit);
    }
  },
);

registerHandler(
  "inlineBlameOnAfterInsert",
  (data: { buffer_id: number }): void => {
    invalidateBuffer(data.buffer_id);
  },
);

registerHandler(
  "inlineBlameOnAfterDelete",
  (data: { buffer_id: number }): void => {
    invalidateBuffer(data.buffer_id);
  },
);

registerHandler(
  "inlineBlameOnAfterFileSave",
  (data: { buffer_id: number; path: string }): void => {
    invalidatePath(data.path);
    lineSnapshots.delete(data.buffer_id);
    if (editor.getActiveBufferId() === data.buffer_id) requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameOnLinesChanged",
  (data: LinesChangedHookArgs): void => {
    if (
      data.buffer_id !== editor.getActiveBufferId() ||
      diffBufferHashes.has(data.buffer_id)
    ) {
      return;
    }
    cacheLineSnapshots(data);
    const waiting = snapshotWait;
    if (
      waiting !== null &&
      !waiting.graceActive &&
      waiting.target.bufferId === data.buffer_id &&
      data.lines.some(
        (line) => line.line_number === waiting.target.line,
      ) &&
      targetIsCurrent(waiting.target)
    ) {
      snapshotWait = null;
      requestLine(data.buffer_id, waiting.target.line, true, 0);
    }
  },
);

registerHandler(
  "inlineBlameOnMouseClick",
  (data: MouseClickHookArgs): void => {
    const rendered = renderedBlame;
    if (
      rendered === null ||
      data.button !== "left" ||
      data.buffer_id !== rendered.bufferId ||
      data.buffer_row !== rendered.line ||
      data.buffer_col === null ||
      data.buffer_col !== rendered.lineByteLength ||
      rendered.arrowTextColumn === null ||
      rendered.renderedLineWidth === null
    ) {
      return;
    }

    const info = editor.getBufferInfo(rendered.bufferId);
    if (
      info === null ||
      info.view_mode !== "source" ||
      info.is_composing_in_any_split ||
      info.line_count === null ||
      !Number.isInteger(info.line_count) ||
      info.line_count < 0
    ) {
      return;
    }

    const split = editor.listSplits().find(
      (candidate) =>
        candidate.bufferId === rendered.bufferId &&
        candidate.x === data.content_x &&
        data.content_y >= candidate.y &&
        data.content_y < candidate.y + candidate.height,
    );
    // The mouse hook runs before Fresh focuses a clicked split. BufferInfo's
    // view state describes only the active split, so fail closed elsewhere.
    if (split === undefined || split.splitId !== editor.getActiveSplitId()) {
      return;
    }

    const rawConfig = asRecord(editor.getConfig());
    const editorConfig = asRecord(rawConfig.editor);
    if (typeof editorConfig.line_numbers !== "boolean") return;
    const lineNumberDigits = Math.max(
      2,
      String(Math.max(1, info.line_count)).length,
    );
    const gutterWidth = editorConfig.line_numbers
      ? 1 + lineNumberDigits + 3
      : 0;
    const viewport = split.viewport;
    if (
      !Number.isInteger(viewport.width) ||
      !Number.isInteger(viewport.leftColumn) ||
      viewport.width <= gutterWidth + 1 ||
      viewport.leftColumn < 0
    ) {
      return;
    }

    const languageConfig = asRecord(
      asRecord(rawConfig.languages)[info.language],
    );
    const configuredWrapColumn =
      typeof languageConfig.wrap_column === "number"
        ? languageConfig.wrap_column
        : typeof editorConfig.wrap_column === "number"
          ? editorConfig.wrap_column
          : null;
    const wrapWidth = Math.min(
      viewport.width,
      configuredWrapColumn !== null &&
          Number.isFinite(configuredWrapColumn) &&
          configuredWrapColumn > 0
        ? Math.floor(configuredWrapColumn)
        : viewport.width,
    );
    const singleRowWidth = Math.max(1, wrapWidth - 1 - gutterWidth);
    if (rendered.renderedLineWidth > singleRowWidth) return;

    const arrowColumn =
      data.content_x +
      gutterWidth +
      rendered.arrowTextColumn -
      viewport.leftColumn;
    const textStart = data.content_x + gutterWidth;
    const textEnd = data.content_x + viewport.width;
    if (
      arrowColumn < textStart ||
      arrowColumn + rendered.arrowWidth > textEnd ||
      data.column < arrowColumn ||
      data.column >= arrowColumn + rendered.arrowWidth
    ) {
      return;
    }
    void showDiff({ ...rendered });
  },
);

registerHandler(
  "inlineBlameOnFocusGained",
  (): void => {
    const bufferId = editor.getActiveBufferId();
    if (bufferId > 0) invalidatePath(editor.getBufferPath(bufferId));
    requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameOnTrustChanged",
  (): void => {
    if (editor.workspaceTrustLevel() !== "trusted") stopAllDiffProcesses();
    requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameOnConfigChanged",
  (): void => {
    config = readConfig();
    if (!config.enabled) stopAllDiffProcesses();
    requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameRefresh",
  (): void => {
    const bufferId = editor.getActiveBufferId();
    if (bufferId > 0) invalidatePath(editor.getBufferPath(bufferId));
    lineSnapshots.delete(bufferId);
    requestActiveLine(true);
  },
);

registerHandler(
  "inlineBlameOpenCommit",
  (): void => {
    if (renderedBlame === null) {
      editor.setStatus("Inline Blame: no committed line is selected");
      return;
    }
    void showDiff({ ...renderedBlame });
  },
);

const subscriptions = [
  ["cursor_moved", "inlineBlameOnCursorMoved"],
  ["buffer_activated", "inlineBlameOnBufferActivated"],
  ["buffer_deactivated", "inlineBlameOnBufferDeactivated"],
  ["buffer_closed", "inlineBlameOnBufferClosed"],
  ["after_insert", "inlineBlameOnAfterInsert"],
  ["after_delete", "inlineBlameOnAfterDelete"],
  ["after_file_save", "inlineBlameOnAfterFileSave"],
  ["lines_changed", "inlineBlameOnLinesChanged"],
  ["mouse_click", "inlineBlameOnMouseClick"],
  ["focus_gained", "inlineBlameOnFocusGained"],
  ["trust_changed", "inlineBlameOnTrustChanged"],
  ["config_changed", "inlineBlameOnConfigChanged"],
] as const;

for (const [event, handler] of subscriptions) editor.on(event, handler);

editor.registerCommand(
  "Inline Blame: Refresh",
  "Refresh Git blame for the current line",
  "inlineBlameRefresh",
);
editor.registerCommand(
  "Inline Blame: Open Commit Diff",
  "Open the current line's commit diff",
  "inlineBlameOpenCommit",
);

requestActiveLine(true);
debug(`version ${PLUGIN_VERSION} initialized`);
