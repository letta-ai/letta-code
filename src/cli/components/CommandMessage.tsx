import { Box, Text } from "ink";
import { memo, useEffect, useState } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors.js";

type CommandLine = {
  kind: "command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "finished";
  success?: boolean;
};

// BlinkDot component for running commands
const BlinkDot: React.FC<{ color?: string }> = ({ color = "yellow" }) => {
  const [on, setOn] = useState(true);
  useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 400);
    return () => clearInterval(t);
  }, []);
  // Visible = colored dot; Off = space (keeps width/alignment)
  return <Text color={color}>{on ? "●" : " "}</Text>;
};

/**
 * CommandMessage - Rich formatting version with two-column layout
 * Matches the formatting pattern used by other message types
 *
 * Features:
 * - Two-column layout with left gutter (2 chars) and right content area
 * - Proper terminal width calculation and wrapping
 * - Markdown rendering for output
 * - Consistent symbols (● for command, ⎿ for result)
 */
export const CommandMessage = memo(({ line }: { line: CommandLine }) => {
  const columns = useTerminalWidth();
  const rightWidth = Math.max(0, columns - 2); // gutter is 2 cols

  // Determine dot state based on phase and success
  const getDotElement = () => {
    if (!line.phase || line.phase === "finished") {
      // Show red dot for failed commands, green for successful
      if (line.success === false) {
        return <Text color={colors.command.error}>●</Text>;
      }
      return <Text color={colors.tool.completed}>●</Text>;
    }
    if (line.phase === "running") {
      return <BlinkDot color={colors.command.running} />;
    }
    return <Text>●</Text>;
  };

  return (
    <Box flexDirection="column">
      {/* Command input */}
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {getDotElement()}
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          <Text>{line.input}</Text>
        </Box>
      </Box>

      {/* Command output (if present) */}
      {line.output &&
        line.output
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((outputLine, idx) => {
            const prefixWidth = idx === 0 ? 5 : 8;
            const prefix = idx === 0 ? "  ⎿  " : "     ⎿  ";
            return (
              <Box flexDirection="row" key={idx}>
                <Box width={prefixWidth} flexShrink={0}>
                  <Text>{prefix}</Text>
                </Box>
                <Box flexGrow={1} width={Math.max(0, columns - prefixWidth)}>
                  <Text wrap="wrap">{outputLine}</Text>
                </Box>
              </Box>
            );
          })}
    </Box>
  );
});

CommandMessage.displayName = "CommandMessage";
