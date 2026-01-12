import { Box, Text } from "ink";
import { memo } from "react";
import type { StreamingState } from "../helpers/accumulator";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { BlinkDot } from "./BlinkDot.js";
import { CollapsedOutputDisplay } from "./CollapsedOutputDisplay";
import { colors } from "./colors.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { StreamingOutputDisplay } from "./StreamingOutputDisplay";

type BashCommandLine = {
  kind: "bash_command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "finished";
  success?: boolean;
  streaming?: StreamingState;
};

/**
 * BashCommandMessage - Renders bash mode command output
 * Similar to CommandMessage but with red ! indicator instead of dot
 *
 * Features:
 * - Two-column layout with left gutter (2 chars) and right content area
 * - Red ! indicator (blinking when running)
 * - Proper terminal width calculation and wrapping
 * - Markdown rendering for output
 */
export const BashCommandMessage = memo(
  ({ line }: { line: BashCommandLine }) => {
    const columns = useTerminalWidth();
    const rightWidth = Math.max(0, columns - 2); // gutter is 2 cols

    // Determine indicator state based on phase and success
    const getIndicatorElement = () => {
      if (!line.phase || line.phase === "finished") {
        // Show red ! for both success and failure (it's user-run, not agent-run)
        return <Text color={colors.bash.dot}>!</Text>;
      }
      if (line.phase === "running") {
        return <BlinkDot color={colors.bash.dot} symbol="!" />;
      }
      return <Text color={colors.bash.dot}>!</Text>;
    };

    return (
      <Box flexDirection="column">
        {/* Command input */}
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            {getIndicatorElement()}
            <Text> </Text>
          </Box>
          <Box flexGrow={1} width={rightWidth}>
            <Text>{line.input}</Text>
          </Box>
        </Box>

        {/* Streaming output during execution */}
        {line.phase === "running" && line.streaming && (
          <StreamingOutputDisplay streaming={line.streaming} />
        )}

        {/* Collapsed output after completion */}
        {line.phase === "finished" && line.output && (
          <CollapsedOutputDisplay output={line.output} />
        )}

        {/* Fallback: show output when phase is undefined (legacy bash commands before streaming) */}
        {!line.phase && line.output && (
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text>{"  ⎿  "}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              <MarkdownDisplay text={line.output.replace(/\n+$/, "")} />
            </Box>
          </Box>
        )}
      </Box>
    );
  },
);

BashCommandMessage.displayName = "BashCommandMessage";
