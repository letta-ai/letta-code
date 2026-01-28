import { Box, Text } from "ink";
import { memo } from "react";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay.js";

type UserLine = {
  kind: "user";
  id: string;
  text: string;
};

/**
 * UserMessageRich - Rich formatting version with two-column layout
 * This is a direct port from the old letta-code codebase to preserve the exact styling
 *
 * Features:
 * - Left column (2 chars wide) with "> " prompt indicator
 * - Right column with wrapped text content
 * - Full markdown rendering support
 * - Subtle background color for visual distinction
 */
export const UserMessage = memo(({ line }: { line: UserLine }) => {
  const columns = useTerminalWidth();
  const contentWidth = Math.max(0, columns - 2);

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text backgroundColor={colors.userMessage.background}>{">"} </Text>
      </Box>
      <Box flexGrow={1} width={contentWidth}>
        <MarkdownDisplay
          text={line.text}
          backgroundColor={colors.userMessage.background}
        />
      </Box>
    </Box>
  );
});

UserMessage.displayName = "UserMessage";
