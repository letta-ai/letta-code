import { homedir } from "node:os";
import type { Letta } from "@letta-ai/letta-client";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import type { AgentProvenance } from "../../agent/create";
import { getModelDisplayName } from "../../agent/model";
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
async function getAuthMethod(): Promise<"url" | "api-key" | "oauth"> {
  // Check if custom URL is being used
  if (process.env.LETTA_BASE_URL) {
    return "url";
  }
  // Check if API key from env
  if (process.env.LETTA_API_KEY) {
    return "api-key";
  }
  // Check settings for refresh token (OAuth) from keychain tokens
  const settings = await settingsManager.getSettingsWithSecureTokens();
  if (settings.refreshToken) {
    return "oauth";
  }
  // Check if API key stored in settings or keychain
  if (settings.env?.LETTA_API_KEY) {
    return "api-key";
  }
  return "oauth"; // default
}

type LoadingState =
  | "assembling"
  | "upserting"
  | "updating_tools"
  | "importing"
  | "initializing"
  | "checking"
  | "selecting_global"
  | "ready";

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

  // Get model display name (pretty name if available, otherwise last part of handle)
  // Build full model handle from llm_config (model_endpoint_type/model) like App.tsx does
  const llmConfig = agentState?.llm_config;
  const fullModel =
    llmConfig?.model_endpoint_type && llmConfig?.model
      ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
      : (llmConfig?.model ?? null);
  const model = fullModel
    ? (getModelDisplayName(fullModel) ?? fullModel.split("/").pop())
    : undefined;

  // Get auth method
  const [authMethod, setAuthMethod] = useState<"url" | "api-key" | "oauth">(
    "oauth",
  );

  useEffect(() => {
    getAuthMethod().then(setAuthMethod);
  }, []);
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
    case "updating_tools":
      return "Updating tools...";
    case "importing":
      return "Importing agent...";
    case "checking":
      return "Checking for pending approvals...";
    default:
      return "Loading...";
  }
}
