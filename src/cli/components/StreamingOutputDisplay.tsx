import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import type { StreamingState } from "../helpers/accumulator";

interface StreamingOutputDisplayProps {
  streaming: StreamingState;
  /** Show "(esc to interrupt)" hint - used by bash mode (LET-7199) */
  showInterruptHint?: boolean;
}

/**
 * Display component for streaming bash output during execution.
 * Shows a rolling window of the last 5 lines with elapsed time.
 */
export const StreamingOutputDisplay = memo(
  ({ streaming, showInterruptHint }: StreamingOutputDisplayProps) => {
    // Force re-render every second for elapsed timer
    const [, forceUpdate] = useState(0);
    useEffect(() => {
      const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
      return () => clearInterval(interval);
    }, []);

    const elapsed = Math.floor((Date.now() - streaming.startTime) / 1000);
    const { tailLines, totalLineCount } = streaming;
    const hiddenCount = Math.max(0, totalLineCount - tailLines.length);

    const firstLine = tailLines[0];
    const interruptHint = showInterruptHint ? " (esc to interrupt)" : "";
    if (!firstLine) {
      return (
        <Box>
          <Text
            dimColor
          >{`  ⎿  Running... (${elapsed}s)${interruptHint}`}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        {/* L-bracket on first line - matches ToolCallMessageRich format "  ⎿  " */}
        <Box>
          <Text dimColor>{"  ⎿  "}</Text>
          <Text
            dimColor={!firstLine.isStderr}
            color={firstLine.isStderr ? "red" : undefined}
          >
            {firstLine.text}
          </Text>
        </Box>
        {/* Remaining lines with indent (5 spaces to align with content after bracket) */}
        {tailLines.slice(1).map((line, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines are positional output, stable order within render
            key={i}
            dimColor={!line.isStderr}
            color={line.isStderr ? "red" : undefined}
          >
            {"     "}
            {line.text}
          </Text>
        ))}
        {/* Hidden count + elapsed time */}
        {hiddenCount > 0 && (
          <Text dimColor>
            {"     "}… +{hiddenCount} more lines ({elapsed}s){interruptHint}
          </Text>
        )}
      </Box>
    );
  },
);

StreamingOutputDisplay.displayName = "StreamingOutputDisplay";
