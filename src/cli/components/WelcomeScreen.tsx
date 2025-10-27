import { Box, Text } from "ink";
import { getAsciiArtWidth } from "../helpers/asciiUtils";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { longAsciiLogo, shortAsciiLogo, tinyAsciiLogo } from "./AsciiArt";
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
  const terminalWidth = useTerminalWidth();
  const widthOfLongLogo = getAsciiArtWidth(longAsciiLogo);
  const widthOfShortLogo = getAsciiArtWidth(shortAsciiLogo);

  let displayTitle: string;
  if (terminalWidth >= widthOfLongLogo) {
    displayTitle = longAsciiLogo;
  } else if (terminalWidth >= widthOfShortLogo) {
    displayTitle = shortAsciiLogo;
  } else {
    displayTitle = tinyAsciiLogo;
  }
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
        {displayTitle}
      </Text>
      <Text dimColor>{stateMessages[loadingState]}</Text>
    </Box>
  );
}
