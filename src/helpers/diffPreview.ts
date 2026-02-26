/**
 * Converts internal diff results (AdvancedDiffResult) to wire-safe DiffPreview
 * for the bidirectional protocol. Strips full file contents (oldStr/newStr)
 * and only sends hunks, which is sufficient for rendering.
 */

import { basename } from "node:path";
import type { AdvancedDiffResult, AdvancedHunk } from "../cli/helpers/diff";
import type { DiffHunk, DiffHunkLine, DiffPreview } from "../types/protocol";

function parseHunkLinePrefix(raw: string): DiffHunkLine | null {
  if (raw.length === 0) {
    return { type: "context", content: "" };
  }
  if (raw[0] === "\\") {
    // Metadata line (e.g. "\ No newline at end of file"), not a diff row.
    return null;
  }
  const prefix = raw[0];
  const content = raw.slice(1);
  if (prefix === "+") return { type: "add", content };
  if (prefix === "-") return { type: "remove", content };
  if (prefix === " ") return { type: "context", content };
  // Unknown prefix: preserve full line as context rather than dropping first char.
  return { type: "context", content: raw };
}

function convertHunk(hunk: AdvancedHunk): DiffHunk {
  const lines: DiffHunkLine[] = [];
  for (const line of hunk.lines) {
    const parsed = parseHunkLinePrefix(line.raw);
    if (parsed) {
      lines.push(parsed);
    }
  }

  let oldLines = 0;
  let newLines = 0;
  for (const line of lines) {
    if (line.type === "context") {
      oldLines++;
      newLines++;
    } else if (line.type === "remove") {
      oldLines++;
    } else if (line.type === "add") {
      newLines++;
    }
  }

  return {
    oldStart: hunk.oldStart,
    oldLines,
    newStart: hunk.newStart,
    newLines,
    lines,
  };
}

/**
 * Convert a single AdvancedDiffResult to a wire-safe DiffPreview.
 * For multi-file patch tools, call this once per file operation.
 */
export function toDiffPreview(
  result: AdvancedDiffResult,
  fileNameOverride?: string,
): DiffPreview {
  switch (result.mode) {
    case "advanced":
      return {
        mode: "advanced",
        fileName: fileNameOverride ?? result.fileName,
        hunks: result.hunks.map(convertHunk),
      };
    case "fallback":
      return {
        mode: "fallback",
        fileName: fileNameOverride ?? "unknown",
        reason: result.reason,
      };
    case "unpreviewable":
      return {
        mode: "unpreviewable",
        fileName: fileNameOverride ?? "unknown",
        reason: result.reason,
      };
  }
}

type DiffDeps = {
  computeAdvancedDiff: typeof import("../cli/helpers/diff").computeAdvancedDiff;
  parsePatchToAdvancedDiff: typeof import("../cli/helpers/diff").parsePatchToAdvancedDiff;
  isFileWriteTool: typeof import("../cli/helpers/toolNameMapping").isFileWriteTool;
  isFileEditTool: typeof import("../cli/helpers/toolNameMapping").isFileEditTool;
  isPatchTool: typeof import("../cli/helpers/toolNameMapping").isPatchTool;
  parsePatchOperations: typeof import("../cli/helpers/formatArgsDisplay").parsePatchOperations;
};

let cachedDiffDeps: DiffDeps | null = null;

async function getDiffDeps(): Promise<DiffDeps> {
  if (cachedDiffDeps) return cachedDiffDeps;
  const [diffMod, toolNameMod, formatMod] = await Promise.all([
    import("../cli/helpers/diff"),
    import("../cli/helpers/toolNameMapping"),
    import("../cli/helpers/formatArgsDisplay"),
  ]);
  cachedDiffDeps = {
    computeAdvancedDiff: diffMod.computeAdvancedDiff,
    parsePatchToAdvancedDiff: diffMod.parsePatchToAdvancedDiff,
    isFileWriteTool: toolNameMod.isFileWriteTool,
    isFileEditTool: toolNameMod.isFileEditTool,
    isPatchTool: toolNameMod.isPatchTool,
    parsePatchOperations: formatMod.parsePatchOperations,
  };
  return cachedDiffDeps;
}

/**
 * Compute diff previews for a tool call. Returns an array of DiffPreview
 * (one per file for patch tools, one for Write/Edit tools).
 *
 * Mirrors the diff computation logic in App.tsx:4372-4438.
 */
export async function computeDiffPreviews(
  toolName: string,
  toolArgs: Record<string, unknown>,
): Promise<DiffPreview[]> {
  const {
    computeAdvancedDiff,
    parsePatchToAdvancedDiff,
    isFileWriteTool,
    isFileEditTool,
    isPatchTool,
    parsePatchOperations,
  } = await getDiffDeps();
  const previews: DiffPreview[] = [];

  try {
    if (isFileWriteTool(toolName)) {
      const filePath = toolArgs.file_path as string | undefined;
      if (filePath) {
        const result = computeAdvancedDiff({
          kind: "write",
          filePath,
          content: (toolArgs.content as string) || "",
        });
        previews.push(toDiffPreview(result, basename(filePath)));
      }
    } else if (isFileEditTool(toolName)) {
      const filePath = toolArgs.file_path as string | undefined;
      if (filePath) {
        if (toolArgs.edits && Array.isArray(toolArgs.edits)) {
          const result = computeAdvancedDiff({
            kind: "multi_edit",
            filePath,
            edits: toolArgs.edits as Array<{
              old_string: string;
              new_string: string;
              replace_all?: boolean;
            }>,
          });
          previews.push(toDiffPreview(result, basename(filePath)));
        } else {
          const result = computeAdvancedDiff({
            kind: "edit",
            filePath,
            oldString: (toolArgs.old_string as string) || "",
            newString: (toolArgs.new_string as string) || "",
            replaceAll: toolArgs.replace_all as boolean | undefined,
          });
          previews.push(toDiffPreview(result, basename(filePath)));
        }
      }
    } else if (isPatchTool(toolName) && toolArgs.input) {
      const operations = parsePatchOperations(toolArgs.input as string);
      for (const op of operations) {
        if (op.kind === "add" || op.kind === "update") {
          const result = parsePatchToAdvancedDiff(op.patchLines, op.path);
          if (result) {
            previews.push(toDiffPreview(result, basename(op.path)));
          }
        }
        // Delete operations don't produce diffs
      }
    }
  } catch {
    // Ignore diff computation errors — return whatever we have so far
  }

  return previews;
}
