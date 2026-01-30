import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";

type EventLine = {
  kind: "event";
  id: string;
  eventType: string;
  eventData: Record<string, unknown>;
};

/**
 * EventMessage - Displays event notifications from the server
 *
 * Currently used for compaction events, showing:
 * - What type of event occurred
 * - Key stats from the event data
 *
 * Layout matches StatusMessage with a left column icon (info circle)
 */
export const EventMessage = memo(({ line }: { line: EventLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  // Format the event message based on type
  const formatEventMessage = (): string[] => {
    if (line.eventType === "compaction") {
      const data = line.eventData;
      const lines: string[] = [];

      // Main event line
      lines.push("Context window compacted");

      // Add stats if available
      if (
        data.messages_count_before !== undefined &&
        data.messages_count_after !== undefined
      ) {
        lines.push(
          `  Messages: ${data.messages_count_before} → ${data.messages_count_after}`,
        );
      }
      if (
        data.context_tokens_before !== undefined &&
        data.context_tokens_after !== undefined
      ) {
        lines.push(
          `  Tokens: ${data.context_tokens_before?.toLocaleString()} → ${data.context_tokens_after?.toLocaleString()}`,
        );
      }
      if (data.trigger) {
        lines.push(`  Trigger: ${data.trigger}`);
      }

      return lines;
    }

    // Fallback for unknown event types
    return [`Event: ${line.eventType}`];
  };

  const messageLines = formatEventMessage();

  return (
    <Box flexDirection="column">
      {messageLines.map((text, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static event lines never reorder
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{idx === 0 ? "◆" : " "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text dimColor>{text}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
});

EventMessage.displayName = "EventMessage";
