import { Box } from "ink";
import { memo } from "react";
import type { QueuedMessage } from "../helpers/messageQueueBridge";
import { Text } from "./Text";

interface QueuedMessagesProps {
  messages: QueuedMessage[];
}

export const QueuedMessages = memo(({ messages }: QueuedMessagesProps) => {
  const maxDisplay = 5;
  const displayMessages = messages
    .filter((msg) => msg.kind === "user")
    .map((msg) => msg.text.trim())
    .filter((msg) => msg.length > 0);

  if (displayMessages.length === 0) {
    return null;
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      {displayMessages.slice(0, maxDisplay).map((msg, index) => (
        <Box key={`${index}-${msg.slice(0, 50)}`} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{">"}</Text>
          </Box>
          <Box flexGrow={1}>
            <Text dimColor>{msg}</Text>
          </Box>
        </Box>
      ))}

      {displayMessages.length > maxDisplay && (
        <Box flexDirection="row">
          <Box width={2} flexShrink={0} />
          <Box flexGrow={1}>
            <Text dimColor>
              ...and {displayMessages.length - maxDisplay} more
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
});

QueuedMessages.displayName = "QueuedMessages";
