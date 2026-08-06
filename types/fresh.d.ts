interface SpawnResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface ProcessHandle<T> extends PromiseLike<T> {
  readonly result: Promise<T>;
  kill(): Promise<boolean>;
}

interface LocalPath {
  kind: "local";
  value: string;
}

interface BufferInfo {
  id: number;
  path: string;
  modified: boolean;
  length: number;
  line_count: number | null;
  is_virtual: boolean;
  is_terminal: boolean;
  editing_disabled: boolean;
  view_mode: string;
  is_composing_in_any_split: boolean;
  compose_width: number | null;
  language: string;
  is_preview: boolean;
  splits: number[];
}

interface CursorInfo {
  position: number;
  selection: { start: number; end: number } | null;
  line: number | null;
}

interface SplitSnapshot {
  splitId: number;
  bufferId: number;
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  viewport: {
    topByte: number;
    topLine: number | null;
    leftColumn: number;
    width: number;
    height: number;
  };
}

interface SplitCreated {
  splitId: number;
  sourceSplitId: number;
  bufferId: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MouseClickHookArgs {
  column: number;
  row: number;
  button: string;
  modifiers: string;
  content_x: number;
  content_y: number;
  buffer_id: number | null;
  buffer_row: number | null;
  buffer_col: number | null;
}

interface LinesChangedHookArgs {
  buffer_id: number;
  lines: {
    line_number: number;
    byte_start: number;
    byte_end: number;
    content: string;
  }[];
  epoch: number;
}

interface FreshEditor {
  defineConfigBoolean(
    name: string,
    options: { default: boolean; description?: string },
  ): boolean;
  defineConfigInteger(
    name: string,
    options: {
      default: number;
      description?: string;
      minimum?: number;
      maximum?: number;
    },
  ): number;
  getPluginConfig<T = unknown>(): T;
  getConfig(): unknown;

  getActiveBufferId(): number;
  getActiveSplitId(): number;
  getBufferInfo(bufferId: number): BufferInfo | null;
  getBufferPath(bufferId: number): string;
  getPrimaryCursor(): CursorInfo | null;
  pathDirname(path: string): string;
  pathBasename(path: string): string;
  workspaceTrustLevel(): string;
  stringWidth(text: string): number;

  addVirtualTextStyled(
    bufferId: number,
    virtualTextId: string,
    position: number,
    text: string,
    options: Record<string, unknown>,
    before: boolean,
  ): boolean;
  removeVirtualText(bufferId: number, virtualTextId: string): boolean;
  refreshLines(bufferId: number): boolean;

  spawnProcess(
    command: string,
    args: string[],
    cwd?: string,
    stdoutTo?: string,
  ): ProcessHandle<SpawnResult>;
  delay(durationMs: number): Promise<void>;

  getDataDir(): string;
  localPath(path: string): LocalPath;
  createDir(path: string | LocalPath): boolean;
  fileExists(path: string | LocalPath): boolean;
  writeFile(path: string | LocalPath, content: string): boolean;
  refreshBufferFromDisk(bufferId: number): Promise<number | null>;
  markFileReadOnly(path: string): boolean;
  setIndentationGuide(bufferId: number, enabled: boolean): boolean;

  listSplits(): SplitSnapshot[];
  splitWindow(options: {
    direction?: "vertical" | "horizontal";
    place?: "before" | "after";
    ratio?: number;
    file?: string;
    keepFocus?: boolean;
  }): Promise<SplitCreated>;
  closeOtherBuffersInSplit(bufferId: number, splitId: number): boolean;
  setSplitBuffer(splitId: number, bufferId: number): boolean;
  focusSplit(splitId: number): boolean;

  on(eventName: string, handlerName: string): void;
  off(eventName: string, handlerName: string): void;
  registerCommand(
    name: string,
    description: string,
    handlerName: string,
  ): void;
  setStatus(message: string): void;
  debug(message: string): void;
}

declare function getEditor(): FreshEditor;
declare function registerHandler(name: string, fn: Function): void;
