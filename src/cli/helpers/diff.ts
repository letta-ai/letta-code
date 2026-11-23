import { basename } from "node:path";
import * as Diff from "diff";

export const ADV_DIFF_CONTEXT_LINES = 1;
export const ADV_DIFF_IGNORE_WHITESPACE = false;

export interface AdvancedEditInput {
  kind: "edit";
  filePath: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface AdvancedWriteInput {
  kind: "write";
  filePath: string;
  content: string;
}

export type AdvancedDiffInput = AdvancedEditInput | AdvancedWriteInput;

export interface AdvancedHunkLine {
  raw: string;
}

export interface AdvancedHunk {
  oldStart: number;
  newStart: number;
  lines: AdvancedHunkLine[];
}

export interface AdvancedDiffSuccess {
  mode: "advanced";
  fileName: string;
  oldStr: string;
  newStr: string;
  hunks: AdvancedHunk[];
}

export interface AdvancedDiffFallback {
  mode: "fallback";
  reason: string;
}

export interface AdvancedDiffUnpreviewable {
  mode: "unpreviewable";
  reason: string;
}

export type AdvancedDiffResult =
  | AdvancedDiffSuccess
  | AdvancedDiffFallback
  | AdvancedDiffUnpreviewable;

function readFileOrNull(p: string): string | null {
  try {
    return require("node:fs").readFileSync(p, "utf-8");
  } catch {
    return null;
  }
}

function applyFirstOccurrence(
  content: string,
  oldStr: string,
  newStr: string,
): { ok: true; out: string } | { ok: false; reason: string } {
  const idx = content.indexOf(oldStr);
  if (idx === -1) return { ok: false, reason: "old_string not found" };
  const out =
    content.slice(0, idx) + newStr + content.slice(idx + oldStr.length);
  return { ok: true, out };
}

function applyAllOccurrences(
  content: string,
  oldStr: string,
  newStr: string,
): { ok: true; out: string } | { ok: false; reason: string } {
  if (!oldStr) return { ok: false, reason: "old_string empty" };
  const occurrences = content.split(oldStr).length - 1;
  if (occurrences === 0) return { ok: false, reason: "old_string not found" };
  return { ok: true, out: content.split(oldStr).join(newStr) };
}

export function computeAdvancedDiff(
  input: AdvancedDiffInput,
  opts?: { oldStrOverride?: string },
): AdvancedDiffResult {
  const fileName = basename(input.filePath || "");

  const fileContent =
    opts?.oldStrOverride !== undefined
      ? opts.oldStrOverride
      : readFileOrNull(input.filePath);
  if (fileContent === null && input.kind !== "write") {
    return { mode: "fallback", reason: "File not readable" };
  }

  const oldStr = fileContent ?? "";
  let newStr = oldStr;

  if (input.kind === "write") {
    newStr = input.content;
  } else if (input.kind === "edit") {
    const replaceAll = !!input.replaceAll;
    const applied = replaceAll
      ? applyAllOccurrences(oldStr, input.oldString, input.newString)
      : applyFirstOccurrence(oldStr, input.oldString, input.newString);
    if (!applied.ok) {
      return {
        mode: "unpreviewable",
        reason: `Edit cannot be previewed: ${applied.reason}`,
      };
    }
    newStr = applied.out;
  }

  const patch = Diff.structuredPatch(
    fileName,
    fileName,
    oldStr,
    newStr,
    "Current",
    "Proposed",
    {
      context: ADV_DIFF_CONTEXT_LINES,
      ignoreWhitespace: ADV_DIFF_IGNORE_WHITESPACE,
    },
  );

  const hunks: AdvancedHunk[] = patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    newStart: h.newStart,
    lines: h.lines.map((l) => ({ raw: l })),
  }));

  return { mode: "advanced", fileName, oldStr, newStr, hunks };
}

export function parsePatchToAdvancedDiff(
  patchLines: string[],
  filePath: string,
): AdvancedDiffSuccess | null {
  const fileName = basename(filePath);
  const hunks: AdvancedHunk[] = [];

  let currentHunk: AdvancedHunk | null = null;
  let oldLine = 1;
  let newLine = 1;

  for (const line of patchLines) {
    if (line.startsWith("@@")) {
      if (currentHunk && currentHunk.lines.length > 0) {
        hunks.push(currentHunk);
      }

      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentHunk = {
        oldStart: match?.[1] ? parseInt(match[1], 10) : oldLine,
        newStart: match?.[2] ? parseInt(match[2], 10) : newLine,
        lines: [],
      };
      continue;
    }

    if (!currentHunk) {
      currentHunk = { oldStart: 1, newStart: 1, lines: [] };
    }

    if (line.length === 0) {
      currentHunk.lines.push({ raw: " " });
      oldLine++;
      newLine++;
    } else {
      const prefix = line[0];
      if (prefix === " " || prefix === "-" || prefix === "+") {
        currentHunk.lines.push({ raw: line });
        if (prefix === " " || prefix === "-") oldLine++;
        if (prefix === " " || prefix === "+") newLine++;
      }
    }
  }

  if (currentHunk && currentHunk.lines.length > 0) {
    hunks.push(currentHunk);
  }

  if (hunks.length === 0) return null;

  return {
    mode: "advanced",
    fileName,
    oldStr: "",
    newStr: "",
    hunks,
  };
}
