import { homedir } from "node:os";
import type { Letta } from "@letta-ai/letta-client";
import { Box, Text } from "ink";

import type { AgentProvenance } from "../../agent/create";
import { settingsManager } from "../../settings-manager";
import { getVersion } from "../../version";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { asciiLogo } from "./AsciiArt";
import { colors } from "./colors";

/**
 * Convert absolute path to use ~ for home directory
 */
function toTildePath(absolutePath: string): string {
  const home = homedir();
  if (absolutePath.startsWith(home)) {
    return `~${absolutePath.slice(home.length)}`;
  }
  return absolutePath;
}

/**
 * Determine the auth method used
 */
function getAuthMethod(): "url" | "api-key" | "oauth" {
  // Check if custom URL is being used
  if (process.env.LETTA_BASE_URL) {
    return "url";
  }
  // Check if API key from env
  if (process.env.LETTA_API_KEY) {
    return "api-key";
  }
  // Check settings for refresh token (OAuth)
  const settings = settingsManager.getSettings();
  if (settings.refreshToken) {
    return "oauth";
  }
  // Check if API key stored in settings
  if (settings.env?.LETTA_API_KEY) {
    return "api-key";
  }
  return "oauth"; // default
}

type LoadingState =
  | "assembling"
  | "upserting"
  | "linking"
  | "unlinking"
  | "importing"
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
    // (project/skills → .letta/, others → ~/.letta/)
    const newBlocks = agentProvenance.blocks.filter((b) => b.source === "new");
    const newGlobalBlocks = newBlocks
      .filter((b) => b.label !== "project" && b.label !== "skills")
      .map((b) => b.label);
    const newProjectBlocks = newBlocks
      .filter((b) => b.label === "project" || b.label === "skills")
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
  agentProvenance: _agentProvenance,
}: {
  loadingState: LoadingState;
  continueSession?: boolean;
  agentState?: Letta.AgentState | null;
  agentProvenance?: AgentProvenance | null;
}) {
  // Keep hook call for potential future responsive behavior
  useTerminalWidth();
  const cwd = process.cwd();
  const version = getVersion();

  const logoLines = asciiLogo.trim().split("\n");
  const tildePath = toTildePath(cwd);

  // Get model from agent state - just the last part (after last /)
  const fullModel = agentState?.model || agentState?.llm_config?.model;
  const model = fullModel?.split("/").pop();

  // Get auth method
  const authMethod = getAuthMethod();
  const authDisplay =
    authMethod === "url"
      ? process.env.LETTA_BASE_URL || "Custom URL"
      : authMethod === "api-key"
        ? "API key auth"
        : "OAuth";

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
        {/* Row 1: Letta Code + version */}
        <Box>
          <Text bold>Letta Code</Text>
          <Text color="gray"> v{version}</Text>
        </Box>
        {/* Row 2: model · auth (or just auth while loading) */}
        <Text color="gray">
          {model ? `${model} · ${authDisplay}` : authDisplay}
        </Text>
        {/* Row 3: loading status, then path once ready */}
        <Text color="gray">
          {loadingState === "ready"
            ? tildePath
            : getLoadingMessage(loadingState, !!continueSession)}
        </Text>
      </Box>
    </Box>
  );
}

function getLoadingMessage(
  loadingState: LoadingState,
  continueSession: boolean,
): string {
  switch (loadingState) {
    case "initializing":
      return continueSession ? "Resuming agent..." : "Creating agent...";
    case "assembling":
      return "Assembling tools...";
    case "upserting":
      return "Upserting tools...";
    case "linking":
      return "Attaching tools...";
    case "unlinking":
      return "Removing tools...";
    case "importing":
      return "Importing agent...";
    case "checking":
      return "Checking for pending approvals...";
    default:
      return "Loading...";
  }
}
