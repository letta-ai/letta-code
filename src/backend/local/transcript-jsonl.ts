import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";

interface TrailingFragment {
  byteOffset: number;
  byteLength: number;
  lineNumber?: number;
}

interface ParsedJsonl<T> {
  items: T[];
  trailingFragment?: TrailingFragment;
}

const warnedTrailingFragments = new Map<string, string>();

export interface LocalTranscriptJsonlSuffix<T> {
  items: T[];
  reachedStart: boolean;
}

export interface LocalTranscriptJsonlRepairResult {
  repaired: boolean;
  backupPath?: string;
}

export class LocalTranscriptJsonlCorruptionError extends Error {
  readonly path: string;
  readonly byteOffset: number;
  readonly lineNumber?: number;

  constructor(input: {
    path: string;
    byteOffset: number;
    lineNumber?: number;
    cause: unknown;
  }) {
    const location =
      input.lineNumber === undefined
        ? `byte offset ${input.byteOffset}`
        : `line ${input.lineNumber}, byte offset ${input.byteOffset}`;
    const detail =
      input.cause instanceof Error ? input.cause.message : String(input.cause);
    super(
      `Malformed transcript JSONL in ${input.path} at ${location}: ${detail}`,
    );
    this.name = "LocalTranscriptJsonlCorruptionError";
    this.path = input.path;
    this.byteOffset = input.byteOffset;
    this.lineNumber = input.lineNumber;
  }
}

function isJsonWhitespace(buffer: Buffer): boolean {
  for (const byte of buffer) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && byte !== 0x20) {
      return false;
    }
  }
  return true;
}

function parseJsonlBuffer<T>(input: {
  path: string;
  buffer: Buffer;
  baseByteOffset: number;
  firstLineNumber?: number;
}): ParsedJsonl<T> {
  const items: T[] = [];
  let rowStart = 0;
  let lineNumber = input.firstLineNumber;

  const parseCommittedRow = (rowEnd: number): void => {
    const row = input.buffer.subarray(rowStart, rowEnd);
    if (!isJsonWhitespace(row)) {
      try {
        items.push(JSON.parse(row.toString("utf8")) as T);
      } catch (cause) {
        throw new LocalTranscriptJsonlCorruptionError({
          path: input.path,
          byteOffset: input.baseByteOffset + rowStart,
          lineNumber,
          cause,
        });
      }
    }
    rowStart = rowEnd + 1;
    if (lineNumber !== undefined) {
      lineNumber += 1;
    }
  };

  for (let index = 0; index < input.buffer.length; index++) {
    if (input.buffer[index] === 0x0a) {
      parseCommittedRow(index);
    }
  }

  const finalRow = input.buffer.subarray(rowStart);
  if (isJsonWhitespace(finalRow)) {
    return { items };
  }

  try {
    items.push(JSON.parse(finalRow.toString("utf8")) as T);
    return { items };
  } catch {
    return {
      items,
      trailingFragment: {
        byteOffset: input.baseByteOffset + rowStart,
        byteLength: finalRow.length,
        lineNumber,
      },
    };
  }
}

function trailingFragmentLocation(fragment: TrailingFragment): string {
  return fragment.lineNumber === undefined
    ? `byte offset ${fragment.byteOffset}`
    : `line ${fragment.lineNumber}, byte offset ${fragment.byteOffset}`;
}

function warnAboutTrailingFragment(
  path: string,
  fragment: TrailingFragment,
): void {
  const signature = `${fragment.byteOffset}:${fragment.byteLength}`;
  if (warnedTrailingFragments.get(path) === signature) return;
  warnedTrailingFragments.set(path, signature);
  console.warn(
    [
      `Ignoring an incomplete trailing transcript row in ${path} at ${trailingFragmentLocation(fragment)}.`,
      "Valid preceding rows remain available.",
      "The damaged bytes will be backed up before the next transcript append.",
    ].join(" "),
  );
}

function readFullJsonl<T>(path: string): ParsedJsonl<T> {
  return parseJsonlBuffer<T>({
    path,
    buffer: readFileSync(path),
    baseByteOffset: 0,
    firstLineNumber: 1,
  });
}

function readFinalPhysicalRow(path: string): {
  buffer: Buffer;
  byteOffset: number;
} {
  const size = statSync(path).size;
  if (size === 0) return { buffer: Buffer.alloc(0), byteOffset: 0 };

  const fd = openSync(path, "r");
  const chunks: Buffer[] = [];
  let position = size;
  let byteOffset = 0;
  try {
    while (position > 0) {
      const bytesToRead = Math.min(position, 64 * 1024);
      const chunkStart = position - bytesToRead;
      const chunk = Buffer.alloc(bytesToRead);
      readSync(fd, chunk, 0, bytesToRead, chunkStart);
      const lastNewline = chunk.lastIndexOf(0x0a);
      if (lastNewline >= 0) {
        chunks.unshift(chunk.subarray(lastNewline + 1));
        byteOffset = chunkStart + lastNewline + 1;
        break;
      }
      chunks.unshift(chunk);
      position = chunkStart;
    }
  } finally {
    closeSync(fd);
  }

  return { buffer: Buffer.concat(chunks), byteOffset };
}

export function readLocalTranscriptJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return [];
  const parsed = readFullJsonl<T>(path);
  if (parsed.trailingFragment) {
    warnAboutTrailingFragment(path, parsed.trailingFragment);
  } else {
    warnedTrailingFragments.delete(path);
  }
  return parsed.items;
}

export function readLocalTranscriptJsonlSuffix<T>(
  path: string,
  maxBytes: number,
): LocalTranscriptJsonlSuffix<T> {
  if (!existsSync(path)) return { items: [], reachedStart: true };
  const size = statSync(path).size;
  if (size === 0) return { items: [], reachedStart: true };

  const bytesToRead = Math.min(size, Math.max(1, maxBytes));
  const start = size - bytesToRead;
  const buffer = Buffer.alloc(bytesToRead);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, bytesToRead, start);
  } finally {
    closeSync(fd);
  }

  const reachedStart = start === 0;
  let content = buffer;
  let contentByteOffset = start;
  if (!reachedStart) {
    const firstNewline = buffer.indexOf(0x0a);
    if (firstNewline < 0) {
      return { items: [], reachedStart };
    }
    content = buffer.subarray(firstNewline + 1);
    contentByteOffset += firstNewline + 1;
  }

  const parsed = parseJsonlBuffer<T>({
    path,
    buffer: content,
    baseByteOffset: contentByteOffset,
    ...(reachedStart ? { firstLineNumber: 1 } : {}),
  });
  if (parsed.trailingFragment) {
    warnAboutTrailingFragment(path, parsed.trailingFragment);
  } else {
    warnedTrailingFragments.delete(path);
  }
  return { items: parsed.items, reachedStart };
}

export function repairLocalTranscriptJsonlTail(
  path: string,
): LocalTranscriptJsonlRepairResult {
  if (!existsSync(path)) return { repaired: false };
  const finalRow = readFinalPhysicalRow(path);
  if (isJsonWhitespace(finalRow.buffer)) return { repaired: false };
  try {
    JSON.parse(finalRow.buffer.toString("utf8"));
    appendFileSync(path, "\n");
    return { repaired: true };
  } catch {
    // A non-newline-terminated invalid final row is the only corruption this
    // repair path may remove. Committed rows are validated by normal readers.
  }

  const backupPrefix = `${path}.corrupt-tail-backup-${Date.now()}`;
  let backupPath = backupPrefix;
  let collisionIndex = 1;
  while (existsSync(backupPath)) {
    backupPath = `${backupPrefix}-${collisionIndex}`;
    collisionIndex += 1;
  }
  copyFileSync(path, backupPath);
  truncateSync(path, finalRow.byteOffset);
  warnedTrailingFragments.delete(path);
  console.warn(
    `Removed an incomplete trailing transcript row from ${path}; the original bytes are preserved in ${backupPath}.`,
  );
  return { repaired: true, backupPath };
}
