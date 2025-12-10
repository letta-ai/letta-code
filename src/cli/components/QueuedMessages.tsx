import { Box, Text } from "ink";
import { memo } from "react";

interface QueuedMessagesProps {
  messages: string[];
}

export const QueuedMessages = memo(({ messages }: QueuedMessagesProps) => {
  const maxDisplay = 5;

  return (
    <Box flexDirection="column" marginBottom={1}>
      {messages.slice(0, maxDisplay).map((msg) => (
        <Box key={msg} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{">"}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor>{msg}</Text>
          </Box>
        </Box>
      ))}

      {messages.length > maxDisplay && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <Text dimColor>...and {messages.length - maxDisplay} more</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
});

QueuedMessages.displayName = "QueuedMessages";
