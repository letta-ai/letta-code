import { Box } from "ink";
import { memo } from "react";
import type { StreamingState } from "@/cli/helpers/accumulator";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { INTERRUPTED_BY_USER } from "@/constants";
import { clipToolReturn } from "@/tools/manager";
import { BlinkDot } from "./BlinkDot.js";
import { CollapsedOutputDisplay } from "./CollapsedOutputDisplay";
import { colors } from "./colors.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { StreamingOutputDisplay } from "./StreamingOutputDisplay";
import { Text } from "./Text";

type BashCommandLine = {
  kind: "bash_command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "finished";
  success?: boolean;
  streaming?: StreamingState;
};

export const BashCommandMessage = memo(
  ({ line }: { line: BashCommandLine }) => {
    const columns = useTerminalWidth();
    const rightWidth = Math.max(0, columns - 2);

    const getIndicatorElement = () => {
      if (!line.phase || line.phase === "finished") {
        return <Text color={colors.bash.dot}>!</Text>;
      }
      if (line.phase === "running") {
        return <BlinkDot color={colors.bash.dot} symbol="!" />;
      }
      return <Text color={colors.bash.dot}>!</Text>;
    };

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box width={2} flexShrink={0}>
            {getIndicatorElement()}
            <Text> </Text>
          </Box>
          <Box flexGrow={1} width={rightWidth}>
            <Text>{line.input}</Text>
          </Box>
        </Box>

        {line.phase === "running" && line.streaming && (
          <StreamingOutputDisplay
            streaming={line.streaming}
            showInterruptHint
          />
        )}

        {line.phase === "finished" &&
          line.output &&
          (line.output === INTERRUPTED_BY_USER ? (
            <Box flexDirection="row">
              <Box width={5} flexShrink={0}>
                <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
              </Box>
              <Text color={colors.status.interrupt}>{INTERRUPTED_BY_USER}</Text>
            </Box>
          ) : (
            <CollapsedOutputDisplay output={line.output} maxLines={Infinity} />
          ))}

        {!line.phase && line.output && (
          <Box flexDirection="row">
            <Box width={5} flexShrink={0}>
              <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
            </Box>
            <Box flexGrow={1} width={Math.max(0, columns - 5)}>
              <MarkdownDisplay
                text={clipToolReturn(line.output).replace(/\n+$/, "")}
              />
            </Box>
          </Box>
        )}
      </Box>
    );
  },
);

BashCommandMessage.displayName = "BashCommandMessage";
