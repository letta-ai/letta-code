import type { McpServerConfig } from "./mcp-client";
import { isToolsetPreference } from "./tools/toolset-catalog";
import type { ToolsetPreference } from "./tools/toolset-types";
import type { ClientPreferences } from "./types/client-preferences";

/** Per-agent settings; baseUrl is omitted for the Letta API. */
export interface AgentSettings {
  clientPreferencesByConversation?: Record<string, ClientPreferences>;
  agentId: string;
  baseUrl?: string; // undefined = Letta API (api.letta.com)
  pinned?: boolean; // true if agent is pinned
  memfs?: boolean; // true if memory filesystem is enabled
  toolset?: ToolsetPreference; // Virtual default-conversation preference
  toolsetsByConversation?: Record<string, Exclude<ToolsetPreference, "auto">>;
  systemPromptPreset?: string; // known preset ID, "custom", or undefined (legacy/subagent)
  systemPromptHash?: string; // hash of the managed prompt content last written by Letta Code
  systemPromptVersion?: string; // Letta Code version that wrote systemPromptHash
  mcpServers?: McpServerConfig[]; // MCP servers available only to this agent
}

export function stripEmptyAgentSettings(
  settings: AgentSettings,
): AgentSettings {
  if (!settings.pinned) delete settings.pinned;
  if (settings.memfs === undefined) delete settings.memfs;
  if (!settings.toolset || settings.toolset === "auto") delete settings.toolset;
  if (Object.keys(settings.toolsetsByConversation ?? {}).length === 0) {
    delete settings.toolsetsByConversation;
  }
  if (
    Object.keys(settings.clientPreferencesByConversation ?? {}).length === 0
  ) {
    delete settings.clientPreferencesByConversation;
  }
  if (!settings.systemPromptPreset) delete settings.systemPromptPreset;
  if (!settings.systemPromptHash) delete settings.systemPromptHash;
  if (!settings.systemPromptVersion) delete settings.systemPromptVersion;
  if (!settings.mcpServers || settings.mcpServers.length === 0) {
    delete settings.mcpServers;
  }
  if (!settings.baseUrl) delete settings.baseUrl;
  return settings;
}

export function readToolsetPreference(
  settings: AgentSettings | undefined,
  conversationId: string,
): ToolsetPreference {
  const preference =
    !conversationId || conversationId === "default"
      ? settings?.toolset
      : settings?.toolsetsByConversation?.[conversationId];
  return isToolsetPreference(preference) ? preference : "auto";
}

export function toolsetPreferenceUpdate(
  settings: AgentSettings | undefined,
  preference: ToolsetPreference,
  conversationId: string,
): Partial<AgentSettings> | null {
  if (!conversationId || conversationId === "default") {
    if (preference === "auto" && settings?.toolset === undefined) return null;
    return { toolset: preference };
  }
  const toolsetsByConversation = { ...settings?.toolsetsByConversation };
  if (preference === "auto") {
    if (!(conversationId in toolsetsByConversation)) return null;
    delete toolsetsByConversation[conversationId];
  } else {
    toolsetsByConversation[conversationId] = preference;
  }
  return { toolsetsByConversation };
}

export function readClientPreferences(
  settings: AgentSettings | undefined,
  conversationId: string,
): ClientPreferences {
  return structuredClone(
    settings?.clientPreferencesByConversation?.[conversationId || "default"] ??
      {},
  );
}

export function clientPreferencesUpdate(
  settings: AgentSettings | undefined,
  preferences: ClientPreferences,
  conversationId: string,
): Partial<AgentSettings> | null {
  if (
    JSON.stringify(readClientPreferences(settings, conversationId)) ===
    JSON.stringify(preferences)
  )
    return null;
  const clientPreferencesByConversation = {
    ...settings?.clientPreferencesByConversation,
  };
  if (Object.keys(preferences).length === 0)
    delete clientPreferencesByConversation[conversationId || "default"];
  else
    clientPreferencesByConversation[conversationId || "default"] =
      structuredClone(preferences);
  return { clientPreferencesByConversation };
}
