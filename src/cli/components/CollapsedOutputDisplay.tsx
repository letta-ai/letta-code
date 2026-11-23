import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

const DEFAULT_COLLAPSED_LINES = 3;
const PREFIX_WIDTH = 5;

interface CollapsedOutputDisplayProps {
  output: string;
  maxLines?: number;
  maxChars?: number;
  expanded?: boolean;
  isLast?: boolean;
}

export const CollapsedOutputDisplay = memo(
  ({
    output,
    maxLines = DEFAULT_COLLAPSED_LINES,
    maxChars,
    expanded = false,
    isLast = false,
  }: CollapsedOutputDisplayProps) => {
    const columns = useTerminalWidth();
    const contentWidth = Math.max(0, columns - PREFIX_WIDTH);

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

    const lines = displayOutput.split("\n");
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
        <Box flexDirection="row">
          <Box width={PREFIX_WIDTH} flexShrink={0}>
            <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <MarkdownDisplay text={visibleLines[0] ?? ""} />
          </Box>
        </Box>

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

        {hiddenCount > 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor>
                … +{hiddenCount} lines{isLast ? " (ctrl+o to expand)" : ""}
              </Text>
            </Box>
          </Box>
        )}

        {expanded && lines.length > maxLines && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
              <Text dimColor>(ctrl+o to collapse)</Text>
            </Box>
          </Box>
        )}

        {clippedByChars && hiddenCount === 0 && (
          <Box flexDirection="row">
            <Box width={PREFIX_WIDTH} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={contentWidth}>
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
