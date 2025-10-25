import { Box, Text } from "ink";
import { memo } from "react";

type ToolCallLine = {
  kind: "tool_call";
  id: string;
  toolCallId?: string;
  name?: string;
  argsText?: string;
  resultText?: string;
  resultOk?: boolean;
  phase: "streaming" | "ready" | "running" | "finished";
};

export const ToolCallMessage = memo(({ line }: { line: ToolCallLine }) => {
  const name = line.name ?? "?";
  const args = line.argsText ?? "...";

  let dotColor: string | undefined;
  if (line.phase === "streaming") {
    dotColor = "gray";
  } else if (line.phase === "running") {
    dotColor = "yellow";
  } else if (line.phase === "finished") {
    dotColor = line.resultOk === false ? "red" : "green";
  }

  // Parse and clean up result text for display
  const displayText = (() => {
    if (!line.resultText) return undefined;

    // Try to parse JSON and extract error message for cleaner display
    try {
      const parsed = JSON.parse(line.resultText);
      if (parsed.error && typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {
      // Not JSON or parse failed, use raw text
    }

    // Truncate long results
    return line.resultText.length > 80
      ? `${line.resultText.slice(0, 80)}...`
      : line.resultText;
  })();

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={dotColor}>•</Text> {name}({args})
      </Text>
      {displayText && (
        <Text>
          └ {line.resultOk === false ? "Error" : "Success"}: {displayText}
        </Text>
      )}
    </Box>
  );
});
