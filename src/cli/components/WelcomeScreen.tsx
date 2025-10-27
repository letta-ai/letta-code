import { Box, Text } from "ink";
import Link from "ink-link";
import { getVersion } from "../../version";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
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
  terminalWidth: frozenWidth,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentId?: string;
  terminalWidth?: number;
}) {
  const currentWidth = useTerminalWidth();
  const terminalWidth = frozenWidth ?? currentWidth;
  const cwd = process.cwd();
  const version = getVersion();

  // Split logo into lines for side-by-side rendering
  const logoLines = asciiLogo.trim().split("\n");

  // Determine verbosity level based on terminal width
  const isWide = terminalWidth >= 120;
  const isMedium = terminalWidth >= 80;

  const getAgentMessage = () => {
    if (loadingState === "ready") {
      if (continueSession && agentId) {
        if (isWide) {
          return "Resumed agent, attached 3 memory blocks (persona, human, project)";
        }
        if (isMedium) {
          return "Resumed agent, attached 3 memory blocks";
        }
        return "Resumed agent";
      }
      if (agentId) {
        if (isWide) {
          return "Created a new agent, attached 3 memory blocks (persona, human, project)";
        }
        if (isMedium) {
          return "Created a new agent, attached 3 memory blocks";
        }
        return "Created a new agent";
      }
      return "Ready to go!";
    }
    if (loadingState === "initializing") {
      return continueSession ? "Resuming agent..." : "Creating agent...";
    }
    if (loadingState === "assembling") {
      return "Assembling tools...";
    }
    if (loadingState === "upserting") {
      return "Upserting tools...";
    }
    if (loadingState === "checking") {
      return "Checking for pending approvals...";
    }
    return "";
  };

  const getPathLine = () => {
    if (isMedium) {
      return `Running in ${cwd}`;
    }
    return cwd;
  };

  const getAgentLink = () => {
    if (loadingState === "ready" && agentId) {
      const url = `https://app.letta.com/projects/default-project/agents/${agentId}`;
      if (isWide) {
        return { text: url, url };
      }
      if (isMedium) {
        return { text: agentId, url };
      }
      return { text: "Click to view in ADE", url };
    }
    return null;
  };

  const agentMessage = getAgentMessage();
  const pathLine = getPathLine();
  const agentLink = getAgentLink();

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

      {/* Right column: Text info */}
      <Box flexDirection="column" marginTop={0}>
        <Text bold color={colors.welcome.accent}>
          Letta Code v{version}
        </Text>
        <Text dimColor>{pathLine}</Text>
        {agentMessage && <Text dimColor>{agentMessage}</Text>}
        {agentLink && (
          <Link url={agentLink.url}>
            <Text dimColor>{agentLink.text}</Text>
          </Link>
        )}
      </Box>
    </Box>
  );
}
