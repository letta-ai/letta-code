import { Box } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Text } from "./Text";

type ErrorLine = {
  kind: "error";
  id: string;
  text: string;
};

export const ErrorMessage = memo(({ line }: { line: ErrorLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color="yellow">⚠</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <Text color="yellow">{line.text}</Text>
      </Box>
    </Box>
  );
});

ErrorMessage.displayName = "ErrorMessage";
