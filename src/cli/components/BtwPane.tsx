import { Box, Text, useInput } from "ink";
import { memo } from "react";
import { brandColors } from "./colors.js";

export type BtwState = {
  status: "idle" | "forking" | "streaming" | "complete" | "error";
  question?: string;
  responseText?: string;
  forkedConversationId?: string;
  error?: string;
};

type BtwPaneProps = {
  state: BtwState;
  onJumpToConversation?: (conversationId: string) => void;
  onDismiss?: () => void;
};

export const BtwPane = memo(
  ({ state, onJumpToConversation, onDismiss }: BtwPaneProps) => {
    useInput(
      (input, key) => {
        if (state.status !== "complete") return;

        if (
          input === "j" &&
          state.forkedConversationId &&
          onJumpToConversation
        ) {
          onJumpToConversation(state.forkedConversationId);
        } else if (key.escape || input === "q") {
          onDismiss?.();
        }
      },
      { isActive: state.status === "complete" },
    );

    if (state.status === "idle") {
      return null;
    }

    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={brandColors.primaryAccent}
        paddingX={1}
        marginY={1}
      >
        <Box>
          <Text bold color={brandColors.primaryAccent}>
            btw
          </Text>
          {state.question && (
            <Text dimColor>
              {" "}
              —{" "}
              {state.question.length > 60
                ? `${state.question.slice(0, 60)}...`
                : state.question}
            </Text>
          )}
        </Box>

        {state.status === "forking" && (
          <Text dimColor> Forking conversation...</Text>
        )}

        {state.status === "streaming" && (
          <Text dimColor> Side questing...</Text>
        )}

        {state.responseText && (
          <Box flexDirection="column">
            <Text dimColor> ──</Text>
            <Text>
              {"  "}
              {state.responseText}
            </Text>
          </Box>
        )}

        {state.status === "error" && state.error && (
          <Text color="red"> Error: {state.error}</Text>
        )}

        {state.status === "complete" && state.forkedConversationId && (
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>
              {"  "}Fork: {state.forkedConversationId}
            </Text>
            {onJumpToConversation && (
              <Text dimColor>{"  "}[j] Switch to fork [esc] Dismiss</Text>
            )}
          </Box>
        )}
      </Box>
    );
  },
);

BtwPane.displayName = "BtwPane";
