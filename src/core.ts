export interface BlameInfo {
  commit: string;
  author: string;
  email: string;
  authorTime: number;
  summary: string;
}

export interface LineSnapshot {
  lineNumber: number;
  byteStart: number;
  byteEnd: number;
  content: string;
}

export interface LineAnchor {
  anchor: number;
  before: boolean;
  lineByteLength: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;
const BLAME_HEADER = /^\^?([0-9a-f]+)\s+\d+\s+\d+(?:\s+\d+)?$/i;

function metadataValue(line: string, key: string): string | null {
  const prefix = `${key} `;
  return line.startsWith(prefix) ? line.slice(prefix.length) : null;
}

function cleanEmail(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function parseBlamePorcelain(output: string): BlameInfo | null {
  const lines = output.replace(/\r\n?/g, "\n").split("\n");
  const header = lines[0]?.match(BLAME_HEADER);
  if (header === null || header === undefined) return null;

  let author = "";
  let email = "";
  let authorTime = Number.NaN;
  let summary = "";

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("\t")) break;

    const nextAuthor = metadataValue(line, "author");
    if (nextAuthor !== null) {
      author = nextAuthor;
      continue;
    }
    const nextEmail = metadataValue(line, "author-mail");
    if (nextEmail !== null) {
      email = cleanEmail(nextEmail);
      continue;
    }
    const nextTime = metadataValue(line, "author-time");
    if (nextTime !== null) {
      authorTime = Number.parseInt(nextTime, 10);
      continue;
    }
    const nextSummary = metadataValue(line, "summary");
    if (nextSummary !== null) summary = nextSummary;
  }

  if (!Number.isFinite(authorTime)) return null;
  return {
    commit: header[1] ?? "",
    author,
    email,
    authorTime,
    summary,
  };
}

export function isCommittedHash(hash: string): boolean {
  return /^[0-9a-f]+$/i.test(hash) && !/^0+$/.test(hash);
}

function cleanIdentity(value: string): string {
  return value
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateCodePoints(value: string, maximum: number): string {
  const points = Array.from(value);
  if (points.length <= maximum) return value;
  return `${points.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

export function displayAuthor(info: Pick<BlameInfo, "author" | "email">): string {
  const author = cleanIdentity(info.author);
  const email = cleanIdentity(info.email);
  return truncateCodePoints(author || email || "Unknown author", 48);
}

function relativePhrase(
  value: number,
  unit: string,
  future: boolean,
): string {
  const plural = value === 1 ? unit : `${unit}s`;
  return future ? `in ${value} ${plural}` : `${value} ${plural} ago`;
}

export function formatRelativeTime(
  epochSeconds: number,
  nowMilliseconds = Date.now(),
): string {
  if (!Number.isFinite(epochSeconds)) return "unknown time";

  const delta = Math.round(nowMilliseconds / 1000 - epochSeconds);
  const future = delta < 0;
  const seconds = Math.abs(delta);
  if (seconds < 60) return "just now";
  if (seconds < 60 * 60) {
    return relativePhrase(Math.max(1, Math.floor(seconds / 60)), "minute", future);
  }
  if (seconds < 24 * 60 * 60) {
    return relativePhrase(Math.max(1, Math.floor(seconds / (60 * 60))), "hour", future);
  }
  if (seconds < 7 * 24 * 60 * 60) {
    return relativePhrase(Math.max(1, Math.floor(seconds / (24 * 60 * 60))), "day", future);
  }
  if (seconds < 30 * 24 * 60 * 60) {
    return relativePhrase(
      Math.max(1, Math.floor(seconds / (7 * 24 * 60 * 60))),
      "week",
      future,
    );
  }
  if (seconds < 365 * 24 * 60 * 60) {
    return relativePhrase(
      Math.max(1, Math.floor(seconds / (30 * 24 * 60 * 60))),
      "month",
      future,
    );
  }
  return relativePhrase(
    Math.max(1, Math.floor(seconds / (365 * 24 * 60 * 60))),
    "year",
    future,
  );
}

export function formatBlameLabel(
  info: BlameInfo,
  nowMilliseconds = Date.now(),
): string {
  return ` ${displayAuthor(info)} • ${formatRelativeTime(info.authorTime, nowMilliseconds)}  ↗`;
}

export function utf8ByteLength(value: string): number {
  let length = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) length += 1;
    else if (codePoint <= 0x7ff) length += 2;
    else if (codePoint <= 0xffff) length += 3;
    else length += 4;
  }
  return length;
}

export function lineAnchor(snapshot: LineSnapshot): LineAnchor | null {
  const { byteStart, byteEnd, content } = snapshot;
  if (byteStart < 0 || byteEnd < byteStart) return null;

  if (content.endsWith("\n")) {
    if (byteEnd <= byteStart) return null;
    const endingLength = content.endsWith("\r\n") ? 2 : 1;
    return {
      anchor: byteEnd - endingLength,
      before: true,
      lineByteLength: Math.max(0, byteEnd - byteStart - endingLength),
    };
  }

  const lastIndex = content.length - 1;
  if (lastIndex < 0 || byteEnd === byteStart) return null;
  const lastUnit = content.charCodeAt(lastIndex);
  const previousUnit = lastIndex > 0 ? content.charCodeAt(lastIndex - 1) : 0;
  const lastCharacterStart =
    lastUnit >= 0xdc00 &&
    lastUnit <= 0xdfff &&
    previousUnit >= 0xd800 &&
    previousUnit <= 0xdbff
      ? lastIndex - 1
      : lastIndex;
  const lastCharacter = content.slice(lastCharacterStart);
  return {
    anchor: byteEnd - utf8ByteLength(lastCharacter),
    before: false,
    lineByteLength: byteEnd - byteStart,
  };
}

export function blameArguments(lineNumber: number, fileName: string): string[] {
  const gitLine = Math.max(0, Math.floor(lineNumber)) + 1;
  return [
    "--no-pager",
    "blame",
    "--incremental",
    "-L",
    `${gitLine},${gitLine}`,
    "--",
    fileName,
  ];
}

export function showArguments(commit: string): string[] {
  return [
    "--no-pager",
    "show",
    "--stat",
    "--patch",
    "--no-ext-diff",
    "--no-color",
    commit,
  ];
}
