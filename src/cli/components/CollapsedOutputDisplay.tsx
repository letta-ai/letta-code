import { Box, Text } from "ink";
import { memo } from "react";

const COLLAPSED_LINES = 3;

interface CollapsedOutputDisplayProps {
  output: string; // Full output from completion
}

/**
 * Display component for bash output after completion.
 * Shows first 3 lines with count of hidden lines.
 * Note: expand/collapse (ctrl+o) is deferred to a future PR.
 */
export const CollapsedOutputDisplay = memo(
  ({ output }: CollapsedOutputDisplayProps) => {
    // Keep empty lines for accurate display (don't filter them out)
    const lines = output.split("\n");
    // Remove trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (lines.length === 0) {
      return null;
    }

    const visibleLines = lines.slice(0, COLLAPSED_LINES);
    const hiddenCount = Math.max(0, lines.length - COLLAPSED_LINES);

    return (
      <Box flexDirection="column">
        {/* L-bracket on first line - matches ToolCallMessageRich format "  ⎿  " */}
        <Box>
          <Text>{"  ⎿  "}</Text>
          <Text>{visibleLines[0]}</Text>
        </Box>
        {/* Remaining visible lines with indent (5 spaces to align with content after bracket) */}
        {visibleLines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Lines are positional output, stable order within render
          <Text key={i}>
            {"     "}
            {line}
          </Text>
        ))}
        {/* Hidden count hint */}
        {hiddenCount > 0 && (
          <Text dimColor>
            {"     "}… +{hiddenCount} lines
          </Text>
        )}
      </Box>
    );
  },
);

CollapsedOutputDisplay.displayName = "CollapsedOutputDisplay";
