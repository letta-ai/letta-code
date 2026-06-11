import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

const DEFAULT_COLLAPSED_LINES = 3;
const PREFIX_WIDTH = 5; // `  └  ` or `     `
const RIGHT_PADDING = 1;

interface CollapsedOutputDisplayProps {
  output: string; // Full output from completion
  maxLines?: number; // Max lines to show before collapsing (Infinity = show all)
  maxChars?: number; // Max chars to show before clipping
  expanded?: boolean; // Whether to show full output
  isLast?: boolean; // Whether this is the last shell tool call (shows ctrl+o hint)
}

/**
 * Display component for bash output after completion.
 * Shows first 3 lines with count of hidden lines.
 * Uses proper two-column layout with width constraints for correct wrapping.
 * Toggle expand/collapse with ctrl+o (handled by AppCoordinator).
 */
export const CollapsedOutputDisplay = memo(
  ({
    output,
    maxLines = DEFAULT_COLLAPSED_LINES,
    maxChars,
    expanded = false,
    isLast = false,
  }: CollapsedOutputDisplayProps) => {
    const columns = useTerminalWidth();
    const contentWidth = Math.max(0, columns - PREFIX_WIDTH - RIGHT_PADDING);

    let displayOutput = output;
    let clippedByChars = false;
    if (
      !expanded &&
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

    const showAll =
      expanded || maxLines === Infinity || maxLines >= lines.length;
    const visibleLines = showAll ? lines : lines.slice(0, maxLines);
    const hiddenCount = showAll ? 0 : Math.max(0, lines.length - maxLines);

    return (
      <Box flexDirection="column">
        {/* L-bracket on first line - matches ToolCallMessageRich result prefix */}
        <Box flexDirection="row">
          <Box width={PREFIX_WIDTH} flexShrink={0}>
            <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth} paddingRight={RIGHT_PADDING}>
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
            <Box flexGrow={1} width={contentWidth} paddingRight={RIGHT_PADDING}>
              <MarkdownDisplay text={line} />
            </Box>
          </Box>
        ))}
        {/* Hidden count hint with ctrl+o toggle */}
        {hiddenCount > 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth} paddingRight={RIGHT_PADDING}>
              <Text dimColor>
                … +{hiddenCount} lines{isLast ? " (ctrl+o to expand)" : ""}
              </Text>
            </Box>
          </Box>
        )}
        {/* Collapse hint when expanded */}
        {expanded && lines.length > maxLines && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth} paddingRight={RIGHT_PADDING}>
              <Text dimColor>(ctrl+o to collapse)</Text>
            </Box>
          </Box>
        )}
        {/* Character clipping hint with ctrl+o hint (only if not already showing line count) */}
        {clippedByChars && hiddenCount === 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth} paddingRight={RIGHT_PADDING}>
              <Text dimColor>
                … output clipped{isLast ? " (ctrl+o to expand)" : ""}
              </Text>
            </Box>
          </Box>
        )}
      </Box>
    );
  },
);

CollapsedOutputDisplay.displayName = "CollapsedOutputDisplay";
