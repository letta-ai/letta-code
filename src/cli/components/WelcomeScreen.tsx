import { Box, Text } from "ink";
import { colors } from "./colors";

type LoadingState =
  | "assembling"
  | "upserting"
  | "initializing"
  | "checking"
  | "ready";

export function WelcomeScreen({
  loadingState,
  continueSession,
  agentId,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentId?: string;
}) {
  const getInitializingMessage = () => {
    if (continueSession && agentId) {
      return `Resuming agent ${agentId}...`;
    }
    return "Creating agent...";
  };

  const getReadyMessage = () => {
    if (continueSession && agentId) {
      return `Resumed agent (${agentId}). Ready to go!`;
    }
    if (agentId) {
      return `Created a new agent (${agentId}). Ready to go!`;
    }
    return "Ready to go!";
  };

  const stateMessages: Record<LoadingState, string> = {
    assembling: "Assembling tools...",
    upserting: "Upserting tools...",
    initializing: getInitializingMessage(),
    checking: "Checking for pending approvals...",
    ready: getReadyMessage(),
  };

  return (
    <Box flexDirection="column">
      <Text bold color={colors.welcome.accent}>
        Letta Code
      </Text>
      <Text dimColor>{stateMessages[loadingState]}</Text>
    </Box>
  );
}
