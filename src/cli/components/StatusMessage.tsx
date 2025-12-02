import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";

type StatusLine = {
  kind: "status";
  id: string;
  lines: string[];
};

/**
 * StatusMessage - Displays multi-line status messages
 *
 * Used for agent provenance info at startup, showing:
 * - Whether agent is resumed or newly created
 * - Where memory blocks came from (global/project/new)
 *
 * Layout matches ErrorMessage with a left column icon (grey circle)
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
            <Text dimColor>{text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
});

StatusMessage.displayName = "StatusMessage";
