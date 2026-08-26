import { getBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type { ToolName } from "./tool-definitions";

const AGENT_MCP_TOOL_NAMES: ToolName[] = ["agent_mcp"];

function hasCloudAuthCredentials(): boolean {
  if (process.env.LETTA_API_KEY) {
    return true;
  }

  if (!settingsManager.isReady) {
    return false;
  }

  const settings = settingsManager.getSettings();
  const cachedTokens = settingsManager.getCachedSecureTokens();
  return Boolean(
    settings.env?.LETTA_API_KEY ||
      cachedTokens.apiKey ||
      cachedTokens.refreshToken ||
      settings.refreshToken,
  );
}

export function resolveAgentMcpToolNames(toolNames: ToolName[]): ToolName[] {
  const agentMcpToolSet = new Set<ToolName>(AGENT_MCP_TOOL_NAMES);
  const withoutAgentMcpTools = toolNames.filter(
    (name) => !agentMcpToolSet.has(name),
  );

  if (
    !getBackend().capabilities.serverSideToolManagement ||
    !hasCloudAuthCredentials()
  ) {
    return withoutAgentMcpTools;
  }

  return [...withoutAgentMcpTools, ...AGENT_MCP_TOOL_NAMES];
}
