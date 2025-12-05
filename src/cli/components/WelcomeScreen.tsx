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
  | "linking"
  | "unlinking"
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

  const getMemoryBlocksLine = () => {
    if (loadingState !== "ready" || !agentState?.memory?.blocks) {
      return null;
    }

    const blocks = agentState.memory.blocks;
    const labels = blocks
      .map((b) => b.label)
      .filter(Boolean)
      .join(", ");

    if (labels) {
      return `  → Memory blocks: ${labels}`;
    }
    return null;
  };

  const getAgentMessage = () => {
    if (loadingState === "ready") {
      if (agentId) {
        const baseText = continueSession
          ? "Resumed existing agent:"
          : "Created new agent:";
        return baseText;
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
    if (loadingState === "linking") {
      return "Attaching Letta Code tools...";
    }
    if (loadingState === "unlinking") {
      return "Removing Letta Code tools...";
    }
    if (loadingState === "checking") {
      return "Checking for pending approvals...";
    }
    return "";
  };

  const getAgentLink = () => {
    if (loadingState === "ready" && agentId) {
      const url = `https://app.letta.com/agents/${agentId}`;
      return { text: url, url };
    }
    return null;
  };

  const getPathLine = () => {
    if (isMedium) {
      return `Running in ${cwd}`;
    }
    return cwd;
  };

  const getTip = () => {
    if (loadingState === "ready" && continueSession) {
      return "  → To create a new agent, use --new";
    }
    return null;
  };

  const agentMessage = getAgentMessage();
  const pathLine = getPathLine();
  const memoryBlocksLine = getMemoryBlocksLine();
  const agentLink = getAgentLink();
  const tip = getTip();

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
        {agentMessage && agentLink ? (
          <Box flexDirection="row" gap={1}>
            <Text dimColor>{agentMessage}</Text>
            <Link url={agentLink.url}>
              <Text dimColor>{agentLink.text}</Text>
            </Link>
          </Box>
        ) : agentMessage ? (
          <Text dimColor>{agentMessage}</Text>
        ) : null}
        {memoryBlocksLine && <Text dimColor>{memoryBlocksLine}</Text>}
        {tip && <Text dimColor>{tip}</Text>}
      </Box>
    </Box>
  );
}
