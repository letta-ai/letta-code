import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";

const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/g, "");

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
};

export const AssistantMessage = memo(({ line }: { line: AssistantLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  const normalizedText = normalize(line.text);
  if (!normalizedText.trim()) {
    return null;
  }

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{line.isContinuation ? " " : CLI_GLYPHS.bullet}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <MarkdownDisplay
          text={normalizedText}
          hangingIndent={0}
          contentWidth={contentWidth}
        />
      </Box>
    </Box>
  );
});

AssistantMessage.displayName = "AssistantMessage";
