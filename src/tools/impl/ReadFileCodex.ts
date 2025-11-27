import { promises as fs } from "node:fs";
import { validateRequiredParams } from "./validation.js";

const MAX_LINE_LENGTH = 500;
const TAB_WIDTH = 4;
const COMMENT_PREFIXES = ["#", "//", "--"];

interface IndentationOptions {
  anchor_line?: number;
  max_levels?: number;
  include_siblings?: boolean;
  include_header?: boolean;
  max_lines?: number;
}

interface ReadFileCodexArgs {
  file_path: string;
  offset?: number;
  limit?: number;
  mode?: "slice" | "indentation" | string;
  indentation?: IndentationOptions;
}

interface ReadFileCodexResult {
  content: string;
}

interface LineRecord {
  number: number;
  raw: string;
  display: string;
  indent: number;
}

/**
 * Codex-style read_file tool.
 * Supports both slice mode (simple range) and indentation mode (context-aware block reading).
 */
export async function read_file(
  args: ReadFileCodexArgs,
): Promise<ReadFileCodexResult> {
  validateRequiredParams(args, ["file_path"], "read_file");

  const {
    file_path,
    offset = 1,
    limit = 2000,
    mode = "slice",
    indentation,
  } = args;

  if (offset < 1) {
    throw new Error("offset must be a 1-indexed line number");
  }

  if (limit < 1) {
    throw new Error("limit must be greater than zero");
  }

  let lines: string[];

  if (mode === "indentation") {
    lines = await readIndentationMode(
      file_path,
      offset,
      limit,
      indentation ?? {},
    );
  } else {
    lines = await readSliceMode(file_path, offset, limit);
  }

  return { content: lines.join("\n") };
}

/**
 * Simple slice mode: read lines from offset to offset + limit.
 */
async function readSliceMode(
  filePath: string,
  offset: number,
  limit: number,
): Promise<string[]> {
  const content = await fs.readFile(filePath, "utf8");
  const allLines = content.split(/\r?\n/);

  const collected: string[] = [];
  for (
    let i = offset - 1;
    i < allLines.length && collected.length < limit;
    i++
  ) {
    const line = allLines[i];
    if (line === undefined) break;
    const formatted = formatLine(line);
    collected.push(`L${i + 1}: ${formatted}`);
  }

  if (offset > allLines.length) {
    throw new Error("offset exceeds file length");
  }

  return collected;
}

/**
 * Indentation mode: expand around an anchor line based on indentation levels.
 */
async function readIndentationMode(
  filePath: string,
  offset: number,
  limit: number,
  options: IndentationOptions,
): Promise<string[]> {
  const anchorLine = options.anchor_line ?? offset;
  const maxLevels = options.max_levels ?? 0;
  const includeSiblings = options.include_siblings ?? false;
  const includeHeader = options.include_header ?? true;
  const maxLines = options.max_lines ?? limit;

  if (anchorLine < 1) {
    throw new Error("anchor_line must be a 1-indexed line number");
  }

  if (maxLines < 1) {
    throw new Error("max_lines must be greater than zero");
  }

  // Read and parse all lines
  const content = await fs.readFile(filePath, "utf8");
  const rawLines = content.split(/\r?\n/);

  if (rawLines.length === 0 || anchorLine > rawLines.length) {
    throw new Error("anchor_line exceeds file length");
  }

  // Build line records
  const records: LineRecord[] = rawLines.map((raw, idx) => ({
    number: idx + 1,
    raw,
    display: formatLine(raw),
    indent: measureIndent(raw),
  }));

  // Compute effective indents (blank lines inherit previous indent)
  const effectiveIndents = computeEffectiveIndents(records);

  const anchorIndex = anchorLine - 1;
  const anchorRecord = records[anchorIndex];
  const anchorIndent = effectiveIndents[anchorIndex] ?? 0;

  if (!anchorRecord) {
    throw new Error("anchor_line exceeds file length");
  }

  // Calculate minimum indent to include
  const minIndent =
    maxLevels === 0 ? 0 : Math.max(0, anchorIndent - maxLevels * TAB_WIDTH);

  // Cap by limits
  const finalLimit = Math.min(limit, maxLines, records.length);

  if (finalLimit === 1) {
    return [`L${anchorRecord.number}: ${anchorRecord.display}`];
  }

  // Expand from anchor line
  const out: LineRecord[] = [anchorRecord];
  let i = anchorIndex - 1; // up cursor
  let j = anchorIndex + 1; // down cursor
  let iCounterMinIndent = 0;
  let jCounterMinIndent = 0;

  while (out.length < finalLimit) {
    let progressed = 0;

    // Expand up
    if (i >= 0) {
      const iIndent = effectiveIndents[i];
      const iRecord = records[i];
      if (iIndent !== undefined && iRecord && iIndent >= minIndent) {
        out.unshift(iRecord);
        progressed++;

        // Handle sibling exclusion
        if (iIndent === minIndent && !includeSiblings) {
          const allowHeaderComment = includeHeader && isComment(iRecord);
          const canTakeLine = allowHeaderComment || iCounterMinIndent === 0;

          if (canTakeLine) {
            iCounterMinIndent++;
          } else {
            // Remove the line we just added
            out.shift();
            progressed--;
            i = -1; // Stop moving up
          }
        }

        i--;

        if (out.length >= finalLimit) break;
      } else {
        i = -1; // Stop moving up
      }
    }

    // Expand down
    if (j < records.length) {
      const jIndent = effectiveIndents[j];
      const jRecord = records[j];
      if (jIndent !== undefined && jRecord && jIndent >= minIndent) {
        out.push(jRecord);
        progressed++;

        // Handle sibling exclusion
        if (jIndent === minIndent && !includeSiblings) {
          if (jCounterMinIndent > 0) {
            // Remove the line we just added
            out.pop();
            progressed--;
            j = records.length; // Stop moving down
          }
          jCounterMinIndent++;
        }

        j++;
      } else {
        j = records.length; // Stop moving down
      }
    }

    if (progressed === 0) break;
  }

  // Trim empty lines at start and end
  while (out.length > 0 && out[0]?.raw.trim() === "") {
    out.shift();
  }
  while (out.length > 0 && out[out.length - 1]?.raw.trim() === "") {
    out.pop();
  }

  return out.map((record) => `L${record.number}: ${record.display}`);
}

/**
 * Compute effective indents - blank lines inherit previous line's indent.
 */
function computeEffectiveIndents(records: LineRecord[]): number[] {
  const effective: number[] = [];
  let previousIndent = 0;

  for (const record of records) {
    if (record.raw.trim() === "") {
      effective.push(previousIndent);
    } else {
      previousIndent = record.indent;
      effective.push(previousIndent);
    }
  }

  return effective;
}

/**
 * Measure indentation of a line (tabs = TAB_WIDTH spaces).
 */
function measureIndent(line: string): number {
  let indent = 0;
  for (const char of line) {
    if (char === " ") {
      indent++;
    } else if (char === "\t") {
      indent += TAB_WIDTH;
    } else {
      break;
    }
  }
  return indent;
}

/**
 * Check if a line is a comment.
 */
function isComment(record: LineRecord): boolean {
  const trimmed = record.raw.trim();
  return COMMENT_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/**
 * Format a line for display (truncate if too long).
 */
function formatLine(line: string): string {
  if (line.length > MAX_LINE_LENGTH) {
    return line.substring(0, MAX_LINE_LENGTH);
  }
  return line;
}
