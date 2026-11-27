import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { DiffHunkLine, DiffPreview } from "@/types/protocol_v2";

const LINE_PREFIX: Record<DiffHunkLine["type"], string> = {
  add: "+",
  remove: "-",
  context: " ",
};

function isAdvancedPreview(
  value: unknown,
): value is Extract<DiffPreview, { mode: "advanced" }> {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { mode?: unknown }).mode === "advanced" &&
    Array.isArray((value as { hunks?: unknown }).hunks)
  );
}

export interface ServerDiff {
  diff: AdvancedDiffSuccess;
  touchesExistingContent: boolean;
}

export function serverDiffFromPreviews(diffs: unknown[]): ServerDiff | null {
  const preview = diffs.find(isAdvancedPreview);
  if (!preview) return null;
  let touchesExistingContent = false;
  const hunks = preview.hunks.map((hunk) => ({
    oldStart: hunk.oldStart,
    newStart: hunk.newStart,
    lines: hunk.lines.map((line) => {
      if (line.type !== "add") touchesExistingContent = true;
      return { raw: `${LINE_PREFIX[line.type]}${line.content}` };
    }),
  }));
  return {
    diff: {
      mode: "advanced",
      fileName: preview.fileName,
      oldStr: "",
      newStr: "",
      hunks,
    },
    touchesExistingContent,
  };
}

export function fileEditHeader(
  toolName: string,
  toolInput: Record<string, unknown>,
  diff: ServerDiff | null,
): string | undefined {
  const filePath =
    typeof toolInput.file_path === "string" ? toolInput.file_path : null;
  if (!filePath || !diff) return undefined;
  if (toolName.toLowerCase() !== "write") return `Update ${filePath}?`;
  return diff.touchesExistingContent
    ? `Overwrite ${filePath}?`
    : `Write to ${filePath}?`;
}
