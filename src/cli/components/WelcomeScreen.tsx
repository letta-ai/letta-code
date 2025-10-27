import { Box, Text } from "ink";
import { getVersion } from "../../version";
import { asciiLogo } from "./AsciiArt";
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

  const cwd = process.cwd();
  const version = getVersion();

  // Split logo into lines for side-by-side rendering
  const logoLines = asciiLogo.trim().split("\n");

  return (
    <Box flexDirection="row" marginTop={1}>
      {/* Left column: Logo */}
      <Box flexDirection="column" paddingLeft={1} paddingRight={2}>
        {logoLines.map((line, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Logo lines are static and never reorder
          <Text key={idx} bold color={colors.welcome.accent}>
            {idx === 0 ? `  ${line}` : line}
          </Text>
        ))}
      </Box>

      {/* Right column: Text info (offset down 1 line) */}
      <Box flexDirection="column" marginTop={0}>
        <Text bold color={colors.welcome.accent}>
          Letta Code v{version}
        </Text>
        <Text dimColor>{stateMessages[loadingState]}</Text>
        <Text dimColor>{cwd}</Text>
      </Box>
    </Box>
  );
}
