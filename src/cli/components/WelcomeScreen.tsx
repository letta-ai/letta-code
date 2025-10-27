import type { Letta } from "@letta-ai/letta-client";
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
  agentState,
  terminalWidth: frozenWidth,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentState?: Letta.AgentState | null;
  terminalWidth?: number;
}) {
  const currentWidth = useTerminalWidth();
  const terminalWidth = frozenWidth ?? currentWidth;
  const cwd = process.cwd();
  const version = getVersion();
  const agentId = agentState?.id;

  // Split logo into lines for side-by-side rendering
  const logoLines = asciiLogo.trim().split("\n");

  // Determine verbosity level based on terminal width
  const isWide = terminalWidth >= 120;
  const isMedium = terminalWidth >= 80;

  const getMemoryBlocksText = () => {
    if (!agentState?.memory?.blocks) {
      return null;
    }

    const blocks = agentState.memory.blocks;
    const count = blocks.length;
    const labels = blocks
      .map((b) => b.label)
      .filter(Boolean)
      .join(", ");

    if (isWide && labels) {
      return `attached ${count} memory block${count !== 1 ? "s" : ""} (${labels})`;
    }
    if (isMedium) {
      return `attached ${count} memory block${count !== 1 ? "s" : ""}`;
    }
    return null;
  };

  const getAgentMessage = () => {
    if (loadingState === "ready") {
      const memoryText = getMemoryBlocksText();
      const baseText =
        continueSession && agentId
          ? "Resumed agent"
          : agentId
            ? "Created a new agent"
            : "Ready to go!";

      if (memoryText) {
        return `${baseText}, ${memoryText}`;
      }
      return baseText;
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
      const url = `https://app.letta.com/agents/${agentId}`;
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
