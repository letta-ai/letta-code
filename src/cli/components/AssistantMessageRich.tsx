import { Box } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { MarkdownDisplay } from "./MarkdownDisplay.js";
import { Text } from "./Text";

// Helper function to normalize text - copied from old codebase
const normalize = (s: string) =>
  s
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");

type AssistantLine = {
  kind: "assistant";
  id: string;
  text: string;
  phase: "streaming" | "finished";
  isContinuation?: boolean;
};

/**
 * AssistantMessageRich - Rich formatting version with two-column layout
 * This is a direct port from the old letta-code codebase to preserve the exact styling
 *
 * Features:
 * - Left column (2 chars wide) with bullet point marker (unless continuation)
 * - Right column with wrapped text content
 * - Proper text normalization
 * - Support for markdown rendering (when MarkdownDisplay is available)
 */
export const AssistantMessage = memo(({ line }: { line: AssistantLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  const normalizedText = normalize(line.text);

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{line.isContinuation ? " " : "●"}</Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <MarkdownDisplay text={normalizedText} hangingIndent={0} />
      </Box>
    </Box>
  );
});

AssistantMessage.displayName = "AssistantMessage";
