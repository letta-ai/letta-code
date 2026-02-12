import { Box } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

const DEFAULT_COLLAPSED_LINES = 3;
const PREFIX_WIDTH = 5; // "  ⎿  " or "     "

interface CollapsedOutputDisplayProps {
  output: string; // Full output from completion
  maxLines?: number; // Max lines to show before collapsing (Infinity = show all)
  maxChars?: number; // Max chars to show before clipping
}

/**
 * Display component for bash output after completion.
 * Shows first 3 lines with count of hidden lines.
 * Uses proper two-column layout with width constraints for correct wrapping.
 * Note: expand/collapse (ctrl+o) is deferred to a future PR.
 */
export const CollapsedOutputDisplay = memo(
  ({
    output,
    maxLines = DEFAULT_COLLAPSED_LINES,
    maxChars,
  }: CollapsedOutputDisplayProps) => {
    const columns = useTerminalWidth();
    const contentWidth = Math.max(0, columns - PREFIX_WIDTH);

    let displayOutput = output;
    let clippedByChars = false;
    if (
      typeof maxChars === "number" &&
      maxChars > 0 &&
      output.length > maxChars
    ) {
      displayOutput = `${output.slice(0, maxChars)}…`;
      clippedByChars = true;
    }

    // Keep empty lines for accurate display (don't filter them out)
    const lines = displayOutput.split("\n");
    // Remove trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (lines.length === 0) {
      return null;
    }

    const showAll = maxLines === Infinity || maxLines >= lines.length;
    const visibleLines = showAll ? lines : lines.slice(0, maxLines);
    const hiddenCount = showAll ? 0 : Math.max(0, lines.length - maxLines);

    return (
      <Box flexDirection="column">
        {/* L-bracket on first line - matches ToolCallMessageRich format "  ⎿  " */}
        <Box flexDirection="row">
          <Box width={PREFIX_WIDTH} flexShrink={0}>
            <Text>{"  ⎿  "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <MarkdownDisplay text={visibleLines[0] ?? ""} />
          </Box>
        </Box>
        {/* Remaining visible lines with indent (5 spaces to align with content after bracket) */}
        {visibleLines.slice(1).map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Lines are positional output, stable order within render
          <Box key={i} flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <MarkdownDisplay text={line} />
            </Box>
          </Box>
        ))}
        {/* Hidden count hint */}
        {hiddenCount > 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor>… +{hiddenCount} lines</Text>
            </Box>
          </Box>
        )}
        {/* Character clipping hint (only if not already showing line count) */}
        {clippedByChars && hiddenCount === 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor>… output clipped</Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  },
);

CollapsedOutputDisplay.displayName = "CollapsedOutputDisplay";
