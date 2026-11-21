import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { COMPACTION_SUMMARY_HEADER } from "@/constants";
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

export const EventMessage = memo(({ line }: { line: EventLine }) => {
  const columns = useTerminalWidth();
  const rightWidth = Math.max(0, columns - 2);

  if (line.eventType === "task_notification") {
    const summary = line.summary || "Agent task completed";
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={colors.tool.completed}>{CLI_GLYPHS.bullet}</Text>
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          <Text bold>{summary}</Text>
        </Box>
      </Box>
    );
  }

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

  const dotElement = isRunning ? (
    <BlinkDot color={colors.tool.running} />
  ) : (
    <Text color={colors.tool.completed}>{CLI_GLYPHS.bullet}</Text>
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {dotElement}
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          {isRunning ? (
            <CompactingAnimation />
          ) : (
            <Text bold>Conversation compacted</Text>
          )}
        </Box>
      </Box>

      {/* Result section (only when finished and LETTA_DEBUG is enabled) */}
      {/* By default, hide the verbose summary to avoid overwhelming users */}
      {!isRunning &&
        line.summary &&
        (process.env.LETTA_DEBUG === "1" ||
          process.env.LETTA_DEBUG === "true") && (
          <>
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text dimColor>{`  ${CLI_GLYPHS.result}  `}</Text>
              </Box>
              <Box flexGrow={1} width={Math.max(0, rightWidth - 3)}>
                <Text dimColor>{COMPACTION_SUMMARY_HEADER}</Text>
              </Box>
            </Box>
            <Box flexDirection="row">
              <Text> </Text>
            </Box>
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
