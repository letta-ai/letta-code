import type { Letta } from "@letta-ai/letta-client";
import { Box, Text } from "ink";
import Link from "ink-link";
import type { AgentProvenance } from "../../agent/create";
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
  agentProvenance,
  terminalWidth: frozenWidth,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentState?: Letta.AgentState | null;
  agentProvenance?: AgentProvenance | null;
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
      return `${count} memory block${count !== 1 ? "s" : ""} (${labels})`;
    }
    if (isMedium) {
      return `${count} memory block${count !== 1 ? "s" : ""}`;
    }
    return null;
  };

  const getAgentMessage = () => {
    if (loadingState === "ready") {
      // Memory blocks shown in hints, not in main message
      return continueSession && agentId
        ? "Resumed agent"
        : agentId
          ? "Created a new agent"
          : "Ready to go!";
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

  const getHintLines = (): string[] => {
    if (loadingState !== "ready") return [];

    const hints: string[] = [];

    // For resumed agents, show memory blocks and --new hint
    if (continueSession) {
      if (agentState?.memory?.blocks) {
        const blocks = agentState.memory.blocks;
        const count = blocks.length;
        const labels = blocks
          .map((b) => b.label)
          .filter(Boolean)
          .join(", ");
        if (labels) {
          hints.push(`→ Attached ${count} memory block${count !== 1 ? "s" : ""}: ${labels}`);
        }
      }
      hints.push("→ To create a new agent, use --new");
      return hints;
    }

    // For new agents with provenance, show block sources
    if (agentProvenance) {
      // Blocks reused from existing storage
      const reusedGlobalBlocks = agentProvenance.blocks
        .filter((b) => b.source === "global")
        .map((b) => b.label);
      const reusedProjectBlocks = agentProvenance.blocks
        .filter((b) => b.source === "project")
        .map((b) => b.label);

      // New blocks - categorize by where they'll be stored
      // (project/skills → .letta/, others → ~/.letta/)
      const newBlocks = agentProvenance.blocks.filter((b) => b.source === "new");
      const newGlobalBlocks = newBlocks
        .filter((b) => b.label !== "project" && b.label !== "skills")
        .map((b) => b.label);
      const newProjectBlocks = newBlocks
        .filter((b) => b.label === "project" || b.label === "skills")
        .map((b) => b.label);

      if (reusedGlobalBlocks.length > 0) {
        hints.push(`→ Reusing from global (~/.letta/): ${reusedGlobalBlocks.join(", ")}`);
      }
      if (newGlobalBlocks.length > 0) {
        hints.push(`→ Created in global (~/.letta/): ${newGlobalBlocks.join(", ")}`);
      }
      if (reusedProjectBlocks.length > 0) {
        hints.push(`→ Reusing from project (.letta/): ${reusedProjectBlocks.join(", ")}`);
      }
      if (newProjectBlocks.length > 0) {
        hints.push(`→ Created in project (.letta/): ${newProjectBlocks.join(", ")}`);
      }
    }

    return hints;
  };

  const agentMessage = getAgentMessage();
  const pathLine = getPathLine();
  const agentLink = getAgentLink();
  const hintLines = getHintLines();

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
        {agentMessage && (
          <Text dimColor>
            {agentMessage}
            {agentLink && (
              <>
                {": "}
                <Link url={agentLink.url}>
                  <Text dimColor>{agentLink.url}</Text>
                </Link>
              </>
            )}
          </Text>
        )}
        {hintLines.map((hint, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Hint lines are static and never reorder
          <Text key={idx} dimColor>
            {hint}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
