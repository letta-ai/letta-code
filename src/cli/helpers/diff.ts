import { basename } from "node:path";
import * as Diff from "diff";

export const ADV_DIFF_CONTEXT_LINES = 1; // easy to adjust later
export const ADV_DIFF_IGNORE_WHITESPACE = true; // easy to flip later

export type AdvancedDiffVariant = "write" | "edit" | "multi_edit";

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

export interface AdvancedMultiEditInput {
  kind: "multi_edit";
  filePath: string;
  edits: Array<{
    old_string: string;
    new_string: string;
    replace_all?: boolean;
  }>;
}

export type AdvancedDiffInput =
  | AdvancedEditInput
  | AdvancedWriteInput
  | AdvancedMultiEditInput;

export interface AdvancedHunkLine {
  raw: string; // original line from structuredPatch (includes prefix)
}

export interface AdvancedHunk {
  oldStart: number;
  newStart: number;
  lines: AdvancedHunkLine[]; // pass through; renderer will compute numbers/word pairs
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
    // Fall back to node:fs for sync reading
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

  // Fetch current content (oldStr). For write on new file, treat missing as '' and continue.
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
  } else if (input.kind === "multi_edit") {
    let working = oldStr;
    for (const e of input.edits) {
      const replaceAll = !!e.replace_all;
      if (replaceAll) {
        const occ = working.split(e.old_string).length - 1;
        if (occ === 0)
          return { mode: "unpreviewable", reason: "Edit not found in file" };
        const res = applyAllOccurrences(working, e.old_string, e.new_string);
        if (!res.ok)
          return {
            mode: "unpreviewable",
            reason: `Edit cannot be previewed: ${res.reason}`,
          };
        working = res.out;
      } else {
        const occ = working.split(e.old_string).length - 1;
        if (occ === 0)
          return { mode: "unpreviewable", reason: "Edit not found in file" };
        if (occ > 1)
          return {
            mode: "unpreviewable",
            reason: `Multiple matches (${occ}), replace_all=false`,
          };
        const res = applyFirstOccurrence(working, e.old_string, e.new_string);
        if (!res.ok)
          return {
            mode: "unpreviewable",
            reason: `Edit cannot be previewed: ${res.reason}`,
          };
        working = res.out;
      }
    }
    newStr = working;
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
