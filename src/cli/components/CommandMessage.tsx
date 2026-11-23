import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { BlinkDot } from "./BlinkDot.js";
import { colors } from "./colors.js";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";

type CommandLine = {
  kind: "command";
  id: string;
  input: string;
  output: string;
  phase?: "running" | "waiting" | "finished";
  success?: boolean;
  dimOutput?: boolean;
  preformatted?: boolean;
};

export const CommandMessage = memo(({ line }: { line: CommandLine }) => {
  const columns = useTerminalWidth();
  const rightWidth = Math.max(0, columns - 2);
  if (line.phase === "waiting") {
    return null;
  }

  const getDotElement = () => {
    if (!line.phase || line.phase === "finished") {
      if (line.success === false) {
        return <Text color={colors.command.error}>{CLI_GLYPHS.bullet}</Text>;
      }
      return <Text color={colors.tool.completed}>{CLI_GLYPHS.bullet}</Text>;
    }
    if (line.phase === "running") {
      return <BlinkDot color={colors.command.running} />;
    }
    return <Text>{CLI_GLYPHS.bullet}</Text>;
  };

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          {getDotElement()}
          <Text> </Text>
        </Box>
        <Box flexGrow={1} width={rightWidth}>
          <Text>{line.input}</Text>
        </Box>
      </Box>

      {line.output && (
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text>{`  ${CLI_GLYPHS.result}  `}</Text>
          </Box>
          <Box flexGrow={1} width={Math.max(0, columns - 5)}>
            {line.preformatted ? (
              <Text>{line.output}</Text>
            ) : (
              <MarkdownDisplay text={line.output} dimColor={line.dimOutput} />
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
});

CommandMessage.displayName = "CommandMessage";
