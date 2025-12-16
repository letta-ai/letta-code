import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";

type CommandLine = {
  kind: "command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "finished";
  success?: boolean;
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
      {line.output && (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text>{"  ⎿  "}</Text>
          </Box>
          <Box flexGrow={1} width={Math.max(0, columns - 5)}>
            <MarkdownDisplay text={line.output} />
          </Box>
        </Box>
      )}
    </Box>
  );
});

CommandMessage.displayName = "CommandMessage";
