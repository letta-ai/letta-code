import type { Letta } from "@letta-ai/letta-client";
import { Box, Text } from "ink";
import Link from "ink-link";
import type { AgentProvenance } from "../../agent/create";
import { isProjectBlock } from "../../agent/memory";
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

/**
 * Generate status hints based on session type and block provenance.
 * Pure function - no React dependencies.
 */
export function getAgentStatusHints(
  continueSession: boolean,
  agentState?: Letta.AgentState | null,
  agentProvenance?: AgentProvenance | null,
): string[] {
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
        hints.push(
          `→ Attached ${count} memory block${count !== 1 ? "s" : ""}: ${labels}`,
        );
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
    // (project blocks → .letta/, others → ~/.letta/)
    const newBlocks = agentProvenance.blocks.filter((b) => b.source === "new");
    const newGlobalBlocks = newBlocks
      .filter((b) => !isProjectBlock(b.label))
      .map((b) => b.label);
    const newProjectBlocks = newBlocks
      .filter((b) => isProjectBlock(b.label))
      .map((b) => b.label);

    if (reusedGlobalBlocks.length > 0) {
      hints.push(
        `→ Reusing from global (~/.letta/): ${reusedGlobalBlocks.join(", ")}`,
      );
    }
    if (newGlobalBlocks.length > 0) {
      hints.push(
        `→ Created in global (~/.letta/): ${newGlobalBlocks.join(", ")}`,
      );
    }
    if (reusedProjectBlocks.length > 0) {
      hints.push(
        `→ Reusing from project (.letta/): ${reusedProjectBlocks.join(", ")}`,
      );
    }
    if (newProjectBlocks.length > 0) {
      hints.push(
        `→ Created in project (.letta/): ${newProjectBlocks.join(", ")}`,
      );
    }
  }

  return hints;
}

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

  const logoLines = asciiLogo.trim().split("\n");
  const isMedium = terminalWidth >= 80;

  const statusMessage = getStatusMessage(
    loadingState,
    !!continueSession,
    agentId,
  );
  const pathLine = isMedium ? `Running in ${cwd}` : cwd;
  const agentUrl = agentId ? `https://app.letta.com/agents/${agentId}` : null;
  const hints =
    loadingState === "ready"
      ? getAgentStatusHints(!!continueSession, agentState, agentProvenance)
      : [];

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
        {statusMessage && (
          <Text dimColor>
            {statusMessage}
            {loadingState === "ready" && agentUrl && (
              <>
                {": "}
                <Link url={agentUrl}>
                  <Text dimColor>{agentUrl}</Text>
                </Link>
              </>
            )}
          </Text>
        )}
        {hints.map((hint, idx) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Hint lines are static and never reorder
          <Text key={idx} dimColor>
            {hint}
          </Text>
        ))}
      </Box>
    </Box>
  );
}

function getStatusMessage(
  loadingState: LoadingState,
  continueSession: boolean,
  agentId?: string,
): string {
  switch (loadingState) {
    case "ready":
      return continueSession && agentId
        ? "Resumed agent"
        : agentId
          ? "Created a new agent"
          : "Ready to go!";
    case "initializing":
      return continueSession ? "Resuming agent..." : "Creating agent...";
    case "assembling":
      return "Assembling tools...";
    case "upserting":
      return "Upserting tools...";
    case "linking":
      return "Attaching Letta Code tools...";
    case "unlinking":
      return "Removing Letta Code tools...";
    case "checking":
      return "Checking for pending approvals...";
    default:
      return "";
  }
}
