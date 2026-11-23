import { Box } from "ink";
import { memo, useEffect, useState } from "react";
import type { StreamingState } from "@/cli/helpers/accumulator";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { Text } from "./Text";

interface StreamingOutputDisplayProps {
  streaming: StreamingState;
  showInterruptHint?: boolean;
}

export const StreamingOutputDisplay = memo(
  ({ streaming, showInterruptHint }: StreamingOutputDisplayProps) => {
    const columns = useTerminalWidth();
    const [, forceUpdate] = useState(0);
    useEffect(() => {
      const interval = setInterval(() => forceUpdate((n) => n + 1), 1000);
      return () => clearInterval(interval);
    }, []);

    const elapsed = Math.floor((Date.now() - streaming.startTime) / 1000);
    const { tailLines, totalLineCount } = streaming;
    const hiddenCount = Math.max(0, totalLineCount - tailLines.length);
    const contentWidth = Math.max(10, columns - 5);

    const clipToWidth = (text: string): string => {
      if (text.length <= contentWidth) {
        return text;
      }
      if (contentWidth <= 1) {
        return "…";
      }
      return `${text.slice(0, contentWidth - 1)}…`;
    };

    const firstLine = tailLines[0];
    const interruptHint = showInterruptHint ? " (esc to interrupt)" : "";
    if (!firstLine) {
      return (
        <Box>
          <Text
            dimColor
          >{`  ${CLI_GLYPHS.result}  Running... (${elapsed}s)${interruptHint}`}</Text>
        </Box>
      );
    }

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{`  ${CLI_GLYPHS.result}  `}</Text>
          <Text
            dimColor={!firstLine.isStderr}
            color={firstLine.isStderr ? "red" : undefined}
          >
            {clipToWidth(firstLine.text)}
          </Text>
        </Box>

        {tailLines.slice(1).map((line, i) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: Lines are positional output, stable order within render
            key={i}
            dimColor={!line.isStderr}
            color={line.isStderr ? "red" : undefined}
          >
            {"     "}
            {clipToWidth(line.text)}
          </Text>
        ))}

        {hiddenCount > 0 && (
          <Text dimColor>
            {"     "}… +{hiddenCount} more lines ({elapsed}s){interruptHint}
          </Text>
        )}

        {hiddenCount === 0 && (
          <Text dimColor>
            {"     "}({elapsed}s){interruptHint}
          </Text>
        )}
      </Box>
    );
  },
);

StreamingOutputDisplay.displayName = "StreamingOutputDisplay";
