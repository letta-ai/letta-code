import { Box } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { Text } from "./Text";

type ErrorLine = {
  kind: "error";
  id: string;
  text: string;
  color?: string;
};

/**
 * ErrorMessageRich - Rich formatting version with two-column layout
 *
 * Features:
 * - Left column (2 chars wide) with warning marker
 * - Right column with wrapped text content
 * - Consistent with other Rich message components
 */
export const ErrorMessage = memo(({ line }: { line: ErrorLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  const color = line.color || "yellow";

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={color}>⚠</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <Text color={color}>{line.text}</Text>
      </Box>
    </Box>
  );
});

ErrorMessage.displayName = "ErrorMessage";
