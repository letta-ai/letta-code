import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

type StatusLine = {
  kind: "status";
  id: string;
  lines: string[];
};

/**
 * Parse text with **highlighted** segments and render with colors.
 * Text wrapped in ** will be rendered with the accent color.
 */
function renderColoredText(text: string): React.ReactNode {
  // Split on **...** pattern, keeping the delimiters
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      // Remove ** markers and render with accent color
      const content = part.slice(2, -2);
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static text parts never reorder
        <Text key={i} color={colors.footer.agentName}>
          {content}
        </Text>
      );
    }
    // Regular dimmed text
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: Static text parts never reorder
      <Text key={i} dimColor>
        {part}
      </Text>
    );
  });
}

/**
 * StatusMessage - Displays multi-line status messages
 *
 * Used for agent provenance info at startup, showing:
 * - Whether agent is resumed or newly created
 * - Where memory blocks came from (global/project/new)
 *
 * Layout matches ErrorMessage with a left column icon (grey circle)
 * Supports **text** syntax for highlighted (accent colored) text.
 */
export const StatusMessage = memo(({ line }: { line: StatusLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  return (
    <Box flexDirection="column">
      {line.lines.map((text, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static status lines never reorder
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{idx === 0 ? "●" : " "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text>{renderColoredText(text)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
});

StatusMessage.displayName = "StatusMessage";
