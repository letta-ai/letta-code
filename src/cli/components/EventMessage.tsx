import { Box } from "ink";
import { memo } from "react";
import { COMPACTION_SUMMARY_HEADER } from "../../constants";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { BlinkDot } from "./BlinkDot.js";
import { CompactingAnimation } from "./CompactingAnimation";
import { colors } from "./colors.js";
import { Text } from "./Text";

type EventLine = {
  kind: "event";
  id: string;
  eventType: string;
  eventData: Record<string, unknown>;
  phase: "running" | "finished";
  summary?: string;
  stats?: {
    trigger?: string;
    contextTokensBefore?: number;
    contextTokensAfter?: number;
    contextWindow?: number;
    messagesCountBefore?: number;
    messagesCountAfter?: number;
  };
};

/**
 * EventMessage - Displays compaction events like a tool call
 *
 * When running: Shows blinking dot with "Compacting..."
 * When finished: Shows completed dot with summary
 */
export const EventMessage = memo(({ line }: { line: EventLine }) => {
  const columns = useTerminalWidth();
  const rightWidth = Math.max(0, columns - 2);

  // Only handle compaction events for now
  if (line.eventType !== "compaction") {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text dimColor>◆</Text>
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          <Text dimColor>Event: {line.eventType}</Text>
        </Box>
      </Box>
    );
  }

  const isRunning = line.phase === "running";

  // Dot indicator based on phase
  const dotElement = isRunning ? (
    <BlinkDot color={colors.tool.running} />
  ) : (
    <Text color={colors.tool.completed}>●</Text>
  );

  // Format the args display (message count or fallback)
  const formatArgs = (): string => {
    const stats = line.stats;
    if (
      stats?.messagesCountBefore !== undefined &&
      stats?.messagesCountAfter !== undefined
    ) {
      return `${stats.messagesCountBefore} → ${stats.messagesCountAfter} messages`;
    }
    return "...";
  };

  const argsDisplay = formatArgs();

  return (
    <Box flexDirection="column">
      {/* Main tool call line */}
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {dotElement}
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          {isRunning ? (
            <CompactingAnimation />
          ) : (
            <Text bold>Compact({argsDisplay})</Text>
          )}
        </Box>
      </Box>

      {/* Result section (only when finished) - matches CollapsedOutputDisplay format */}
      {!isRunning && line.summary && (
        <>
          {/* Header line with L-bracket */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text dimColor>{"  ⎿  "}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, rightWidth - 3)}>
              <Text dimColor>{COMPACTION_SUMMARY_HEADER}</Text>
            </Box>
          </Box>
          {/* Empty line for separation */}
          <Box flexDirection="row">
            <Text> </Text>
          </Box>
          {/* Summary text - indented with 5 spaces to align */}
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text>{"     "}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, rightWidth - 3)}>
              <Text dimColor wrap="wrap">
                {line.summary}
              </Text>
            </Box>
          </Box>
        </>
      )}
    </Box>
  );
});

EventMessage.displayName = "EventMessage";
