import { Box } from "ink";
import { memo } from "react";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { colors } from "./colors";
import { Text } from "./Text";

type StatusLine = {
  kind: "status";
  id: string;
  lines: string[];
};

function renderColoredText(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);

  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      const content = part.slice(2, -2);
      return (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static text parts never reorder
        <Text key={i} color={colors.footer.agentName}>
          {content}
        </Text>
      );
    }
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: Static text parts never reorder
      <Text key={i} dimColor>
        {part}
      </Text>
    );
  });
}

export const StatusMessage = memo(({ line }: { line: StatusLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  return (
    <Box flexDirection="column">
      {line.lines.map((text, idx) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Static status lines never reorder
        <Box key={idx} flexDirection="row">
          <Box width={2} flexShrink={0}>
            <Text dimColor>{idx === 0 ? CLI_GLYPHS.bullet : " "}</Text>
          </Box>
          <Box flexGrow={1} width={contentWidth}>
            <Text>{renderColoredText(text)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
});

StatusMessage.displayName = "StatusMessage";
