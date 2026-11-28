import { Box, Text } from "ink";
import type { AdvancedDiffSuccess } from "@/cli/helpers/diff";
import type { DiffPreview } from "@/types/protocol_v2";
import { AdvancedDiffRenderer } from "./AdvancedDiffRenderer";

export function sessionDiff(
  preview: Extract<DiffPreview, { mode: "advanced" }>,
): AdvancedDiffSuccess {
  return {
    mode: "advanced",
    fileName: preview.fileName,
    oldStr: "",
    newStr: "",
    hunks: preview.hunks.map((hunk) => ({
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line) => ({
        raw:
          (line.type === "add" ? "+" : line.type === "remove" ? "-" : " ") +
          line.content,
      })),
    })),
  };
}

export function SessionDiff({
  preview,
  showFilename = true,
}: {
  preview: DiffPreview;
  showFilename?: boolean;
}) {
  if (preview.mode !== "advanced")
    return (
      <Text>
        {preview.fileName}: {preview.reason}
      </Text>
    );
  return (
    <Box flexDirection="column">
      {showFilename && <Text bold>{preview.fileName}</Text>}
      <AdvancedDiffRenderer
        kind="write"
        filePath={preview.fileName}
        content=""
        showHeader={false}
        precomputed={sessionDiff(preview)}
      />
    </Box>
  );
}
