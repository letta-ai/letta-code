/**
 * Converts internal diff results (AdvancedDiffResult) to wire-safe DiffPreview
 * for the bidirectional protocol. Strips full file contents (oldStr/newStr)
 * and only sends hunks, which is sufficient for rendering.
 */

import { basename } from "node:path";
import type { AdvancedDiffResult, AdvancedHunk } from "../cli/helpers/diff";
import type { DiffHunk, DiffHunkLine, DiffPreview } from "../types/protocol";

function parseHunkLinePrefix(raw: string): DiffHunkLine {
  if (raw.length === 0) {
    return { type: "context", content: "" };
  }
  const prefix = raw[0];
  const content = raw.slice(1);
  if (prefix === "+") return { type: "add", content };
  if (prefix === "-") return { type: "remove", content };
  return { type: "context", content };
}

function convertHunk(hunk: AdvancedHunk): DiffHunk {
  const lines = hunk.lines.map((l) => parseHunkLinePrefix(l.raw));

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

/**
 * Compute diff previews for a tool call. Returns an array of DiffPreview
 * (one per file for patch tools, one for Write/Edit tools).
 *
 * Mirrors the diff computation logic in App.tsx:4372-4438.
 */
export function computeDiffPreviews(
  toolName: string,
  toolArgs: Record<string, unknown>,
): DiffPreview[] {
  // Lazy imports to avoid circular deps and keep this file lightweight
  const { computeAdvancedDiff, parsePatchToAdvancedDiff } =
    require("../cli/helpers/diff") as typeof import("../cli/helpers/diff");
  const { isFileWriteTool, isFileEditTool, isPatchTool } =
    require("../cli/helpers/toolNameMapping") as typeof import("../cli/helpers/toolNameMapping");
  const { parsePatchOperations } =
    require("../cli/helpers/formatArgsDisplay") as typeof import("../cli/helpers/formatArgsDisplay");

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
