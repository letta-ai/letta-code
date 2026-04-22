import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "../agent/client";
import { resolveModel } from "../agent/model";
import type { MessageChannelToolDiscoveryScope } from "../channels/messageTool";
import { getChannelRegistry } from "../channels/registry";
import { getRoutesForChannel, loadRoutes } from "../channels/routing";
import {
  SUPPORTED_CHANNEL_IDS,
  type SupportedChannelId,
} from "../channels/types";
import type { RuntimeContextSnapshot } from "../runtime-context";
import { settingsManager } from "../settings-manager";
import { toolFilter } from "./filter";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearToolsWithLock,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  getToolNames,
  isGeminiModel,
  isOpenAIModel,
  loadSpecificTools,
  loadTools,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
  type PermissionModeState,
  type PreparedToolExecutionContext,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";
import type { ToolName } from "./toolDefinitions";

// Toolset definitions from manager.ts (single source of truth)
// Keep these as direct references at call-sites (not top-level aliases) to avoid
// temporal-dead-zone issues under circular import initialization.

// Server-side memory tool names that can mutate memory blocks.
// When memfs is enabled, we detach ALL of these from the agent.
export const MEMORY_TOOL_NAMES = new Set([
  "memory",
  "memory_apply_patch",
  "memory_insert",
  "memory_replace",
  "memory_rethink",
]);

// Toolset type including snake_case variants
export type ToolsetName =
  | "codex"
  | "codex_snake"
  | "default"
  | "gemini"
  | "gemini_snake"
  | "none";
export type ToolsetPreference = ToolsetName | "auto";

export function deriveToolsetFromModel(
  modelIdentifier: string,
): "codex" | "gemini" | "default" {
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  return isOpenAIModel(resolvedModel)
    ? "codex"
    : isGeminiModel(resolvedModel)
      ? "gemini"
      : "default";
}

type ScopeModelCarrier = Pick<AgentState, "model" | "llm_config">;

export type PreparedScopeToolContext = {
  preparedToolContext: PreparedToolExecutionContext;
  toolset: ToolsetName;
  toolsetPreference: ToolsetPreference;
  effectiveModel: string | null;
};

function buildModelHandleFromLlmConfig(
  llmConfig:
    | {
        model?: string | null;
        model_endpoint_type?: string | null;
      }
    | null
    | undefined,
): string | null {
  if (!llmConfig) return null;
  if (llmConfig.model_endpoint_type && llmConfig.model) {
    return `${llmConfig.model_endpoint_type}/${llmConfig.model}`;
  }
  return llmConfig.model ?? null;
}

function getPreferredAgentModelHandle(
  agent: ScopeModelCarrier | null | undefined,
): string | null {
  if (!agent) return null;
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  return buildModelHandleFromLlmConfig(agent.llm_config);
}

function getToolNamesForToolset(
  toolsetName: ToolsetName,
  channelToolScope?: MessageChannelToolDiscoveryScope | null,
): ToolName[] {
  let tools: ToolName[];
  switch (toolsetName) {
    case "codex":
      tools = [...OPENAI_PASCAL_TOOLS];
      break;
    case "codex_snake":
      tools = [...OPENAI_DEFAULT_TOOLS];
      break;
    case "gemini":
      tools = [...GEMINI_PASCAL_TOOLS];
      break;
    case "gemini_snake":
      tools = [...GEMINI_DEFAULT_TOOLS];
      break;
    case "none":
      return [];
    default:
      tools = [...ANTHROPIC_DEFAULT_TOOLS];
      break;
  }

  const hasScopedChannelTool =
    channelToolScope !== undefined
      ? (channelToolScope?.channels.length ?? 0) > 0
      : (getChannelRegistry()?.getActiveChannelIds().length ?? 0) > 0;

  // Append channel tool if channels are active (covers ALL pinned toolsets)
  if (hasScopedChannelTool && !tools.includes("MessageChannel" as ToolName)) {
    tools.push("MessageChannel" as ToolName);
  }

  return tools;
}

export async function prepareToolExecutionContextForResolvedTarget(params: {
  modelIdentifier?: string | null;
  toolsetPreference: ToolsetPreference;
  exclude?: ToolName[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  channelToolScope?: MessageChannelToolDiscoveryScope | null;
  runtimeContext?: Partial<RuntimeContextSnapshot>;
}): Promise<PreparedScopeToolContext> {
  const {
    modelIdentifier,
    toolsetPreference,
    exclude,
    workingDirectory,
    permissionModeState,
    channelToolScope,
    runtimeContext,
  } = params;
  const effectiveModel =
    modelIdentifier && modelIdentifier.length > 0
      ? (resolveModel(modelIdentifier) ?? modelIdentifier)
      : null;

  if (toolsetPreference === "auto") {
    const preparedToolContext = await prepareToolExecutionContextForModel(
      effectiveModel ?? undefined,
      {
        exclude,
        workingDirectory,
        permissionModeState,
        channelToolScope,
        runtimeContext,
      },
    );

    return {
      preparedToolContext,
      toolset: effectiveModel
        ? deriveToolsetFromModel(effectiveModel)
        : "default",
      toolsetPreference,
      effectiveModel,
    };
  }

  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    getToolNamesForToolset(toolsetPreference, channelToolScope).filter(
      (toolName) => (exclude ? !exclude.includes(toolName) : true),
    ),
    {
      workingDirectory,
      permissionModeState,
      channelToolScope,
      runtimeContext,
    },
  );

  return {
    preparedToolContext,
    toolset: toolsetPreference,
    toolsetPreference,
    effectiveModel,
  };
}

function resolveConversationChannelToolScope(
  agentId: string,
  conversationId: string,
): MessageChannelToolDiscoveryScope {
  const registry = getChannelRegistry();
  if (!registry) {
    return { channels: [] };
  }

  const channels: Array<{
    channelId: SupportedChannelId;
    accountId?: string | null;
  }> = [];
  const seen = new Set<string>();

  for (const channelId of SUPPORTED_CHANNEL_IDS) {
    loadRoutes(channelId);
    for (const route of getRoutesForChannel(channelId)) {
      if (
        route.agentId !== agentId ||
        route.conversationId !== conversationId ||
        !route.enabled
      ) {
        continue;
      }

      const adapter = registry.getAdapter(channelId, route.accountId);
      if (!adapter?.isRunning()) {
        continue;
      }

      const key = `${channelId}:${route.accountId ?? ""}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      channels.push({
        channelId,
        accountId: route.accountId ?? null,
      });
    }
  }

  return { channels };
}

export async function prepareToolExecutionContextForScope(params: {
  agentId: string;
  conversationId?: string | null;
  overrideModel?: string | null;
  exclude?: ToolName[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
}): Promise<PreparedScopeToolContext> {
  const {
    agentId,
    conversationId,
    overrideModel,
    exclude,
    workingDirectory,
    permissionModeState,
  } = params;

  const client = await getClient();
  const agent = (await client.agents.retrieve(agentId)) as ScopeModelCarrier;
  let effectiveModel =
    overrideModel && overrideModel.length > 0
      ? (resolveModel(overrideModel) ?? overrideModel)
      : null;

  if (!effectiveModel && conversationId && conversationId !== "default") {
    const conversation = await client.conversations.retrieve(conversationId);
    const conversationModel = (conversation as { model?: string | null }).model;
    if (typeof conversationModel === "string" && conversationModel.length > 0) {
      effectiveModel = conversationModel;
    }
  }

  if (!effectiveModel) {
    effectiveModel = getPreferredAgentModelHandle(agent);
  }

  const toolsetPreference = (() => {
    try {
      return settingsManager.getToolsetPreference(agentId);
    } catch {
      return "auto" as const;
    }
  })();

  return prepareToolExecutionContextForResolvedTarget({
    modelIdentifier: effectiveModel,
    toolsetPreference,
    exclude,
    workingDirectory,
    permissionModeState,
    runtimeContext: {
      agentId,
      conversationId: conversationId ?? "default",
      workingDirectory,
    },
    channelToolScope: resolveConversationChannelToolScope(
      agentId,
      conversationId ?? "default",
    ),
  });
}

/**
 * Ensures the server-side memory tool is attached to the agent.
 * Client toolsets may use memory_apply_patch, but server-side base memory tool remains memory.
 *
 * This is a server-side tool swap - client tools are passed via client_tools per-request.
 *
 * @param agentId - The agent ID to update
 * @param modelIdentifier - Model handle (kept for API compatibility)
 * @param useMemoryPatch - Unused compatibility parameter
 */
export async function ensureCorrectMemoryTool(
  agentId: string,
  modelIdentifier: string,
  useMemoryPatch?: boolean,
): Promise<void> {
  void resolveModel(modelIdentifier);
  void useMemoryPatch;
  const client = await getClient();

  try {
    // Need full agent state for tool_rules, so use retrieve with include
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // If agent has no memory tool at all, don't add one
    // This preserves stateless agents (like Incognito) that intentionally have no memory
    const hasAnyMemoryTool =
      mapByName.has("memory") || mapByName.has("memory_apply_patch");
    if (!hasAnyMemoryTool) {
      return;
    }

    // Determine which memory tool we want
    // OpenAI/Codex models use client-side memory_apply_patch now; keep server memory tool as "memory" for all models
    const desiredMemoryTool = "memory";
    const otherMemoryTool =
      desiredMemoryTool === "memory" ? "memory_apply_patch" : "memory";

    // Ensure desired memory tool attached
    let desiredId = mapByName.get(desiredMemoryTool);
    if (!desiredId) {
      const resp = await client.tools.list({ name: desiredMemoryTool });
      desiredId = resp.items[0]?.id;
    }
    if (!desiredId) {
      // No warning needed - the tool might not exist on this server
      return;
    }

    const otherId = mapByName.get(otherMemoryTool);

    // Check if swap is needed
    if (mapByName.has(desiredMemoryTool) && !otherId) {
      // Already has the right tool, no swap needed
      return;
    }

    const currentIds = currentTools
      .map((t) => t.id)
      .filter((id): id is string => typeof id === "string");
    const newIds = new Set(currentIds);
    if (otherId) newIds.delete(otherId);
    newIds.add(desiredId);

    const updatedRules = (agentWithTools.tool_rules || []).map((r) =>
      r.tool_name === otherMemoryTool
        ? { ...r, tool_name: desiredMemoryTool }
        : r,
    );

    await client.agents.update(agentId, {
      tool_ids: Array.from(newIds),
      tool_rules: updatedRules,
    });
  } catch (err) {
    console.warn(
      `Warning: Failed to sync memory tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Detach all memory tools from an agent.
 * Used when enabling memfs (filesystem-backed memory).
 *
 * @param agentId - Agent to detach memory tools from
 * @returns true if any tools were detached
 */
export async function detachMemoryTools(agentId: string): Promise<boolean> {
  const client = await getClient();

  try {
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];

    let detachedAny = false;
    for (const tool of currentTools) {
      if (tool.name && MEMORY_TOOL_NAMES.has(tool.name)) {
        if (tool.id) {
          await client.agents.tools.detach(tool.id, { agent_id: agentId });
          detachedAny = true;
        }
      }
    }

    return detachedAny;
  } catch (err) {
    console.warn(
      `Warning: Failed to detach memory tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}

/**
 * Re-attach the appropriate memory tool to an agent.
 * Used when disabling memfs (filesystem-backed memory).
 * Forces attachment even if agent had no memory tool before.
 *
 * @param agentId - Agent to attach memory tool to
 * @param modelIdentifier - Model handle to determine which memory tool to use
 */
export async function reattachMemoryTool(
  agentId: string,
  modelIdentifier: string,
): Promise<void> {
  void resolveModel(modelIdentifier);
  const client = await getClient();

  try {
    const agentWithTools = await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    });
    const currentTools = agentWithTools.tools || [];
    const mapByName = new Map(currentTools.map((t) => [t.name, t.id]));

    // Determine which memory tool we want
    const desiredMemoryTool = "memory";

    // Already has the tool?
    if (mapByName.has(desiredMemoryTool)) {
      return;
    }

    // Find the tool on the server
    const resp = await client.tools.list({ name: desiredMemoryTool });
    const toolId = resp.items[0]?.id;
    if (!toolId) {
      console.warn(`Memory tool "${desiredMemoryTool}" not found on server`);
      return;
    }

    // Attach it
    await client.agents.tools.attach(toolId, { agent_id: agentId });
  } catch (err) {
    console.warn(
      `Warning: Failed to reattach memory tool: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

type PersistedToolRule = NonNullable<AgentState["tool_rules"]>[number];

interface AgentWithToolsAndRules {
  tags?: string[] | null;
  tool_rules?: PersistedToolRule[];
}

export function shouldClearPersistedToolRules(
  agent: AgentWithToolsAndRules,
): boolean {
  return (
    agent.tags?.includes("origin:letta-code") === true &&
    (agent.tool_rules?.length ?? 0) > 0
  );
}

export async function clearPersistedClientToolRules(
  agentId: string,
): Promise<{ removedToolNames: string[] } | null> {
  const client = await getClient();

  try {
    const agentWithTools = (await client.agents.retrieve(agentId, {
      include: ["agent.tools"],
    })) as AgentWithToolsAndRules;
    if (!shouldClearPersistedToolRules(agentWithTools)) {
      return null;
    }
    const existingRules = agentWithTools.tool_rules || [];

    await client.agents.update(agentId, {
      tool_rules: [],
    });

    return {
      removedToolNames: existingRules
        .map((rule) => rule.tool_name)
        .filter((name): name is string => typeof name === "string"),
    };
  } catch (err) {
    console.warn(
      `Warning: Failed to clear persisted client tool rules: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Force switch to a specific toolset regardless of model.
 *
 * @param toolsetName - The toolset to switch to
 * @param agentId - Agent to relink tools to
 */
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
  agentId: string,
): Promise<void> {
  // Load the appropriate toolset
  // Note: loadTools/loadSpecificTools acquire a switch lock that causes
  // sendMessageStream to wait, preventing messages from being sent with
  // stale or partial tools during the switch.
  let modelForLoading: string;
  if (toolsetName === "none") {
    // Clear tools with lock protection so sendMessageStream() waits
    clearToolsWithLock();
    return;
  } else if (toolsetName === "codex") {
    await loadSpecificTools([...OPENAI_PASCAL_TOOLS]);
    modelForLoading = "openai/gpt-4";
  } else if (toolsetName === "codex_snake") {
    await loadSpecificTools([...OPENAI_DEFAULT_TOOLS]);
    modelForLoading = "openai/gpt-4";
  } else if (toolsetName === "gemini") {
    await loadSpecificTools([...GEMINI_PASCAL_TOOLS]);
    modelForLoading = "google_ai/gemini-3-pro-preview";
  } else if (toolsetName === "gemini_snake") {
    await loadTools("google_ai/gemini-3-pro-preview");
    modelForLoading = "google_ai/gemini-3-pro-preview";
  } else {
    await loadTools("anthropic/claude-sonnet-4");
    modelForLoading = "anthropic/claude-sonnet-4";
  }

  // Ensure base server memory tool is correct for the toolset
  const useMemoryPatch =
    toolsetName === "codex" || toolsetName === "codex_snake";
  await ensureCorrectMemoryTool(agentId, modelForLoading, useMemoryPatch);
}

/**
 * Switches the loaded toolset based on the target model identifier,
 * and ensures the correct memory tool is attached to the agent.
 *
 * @param modelIdentifier - The model handle/id
 * @param agentId - Agent to relink tools to
 * @param onNotice - Optional callback to emit a transcript notice
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  agentId: string,
): Promise<ToolsetName> {
  // Resolve model ID to handle when possible so provider checks stay consistent
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;

  // Load the appropriate set for the target model
  // Note: loadTools acquires a switch lock that causes sendMessageStream to wait,
  // preventing messages from being sent with stale or partial tools during the switch.
  await loadTools(resolvedModel);

  // If no tools were loaded (e.g., unexpected handle or edge-case filter),
  // fall back to loading the default toolset to avoid ending up with only base tools.
  const loadedAfterPrimary = getToolNames().length;
  if (loadedAfterPrimary === 0 && !toolFilter.isActive()) {
    await loadTools();

    // If we *still* have no tools, surface an explicit error instead of silently
    // leaving the agent with only base tools attached.
    if (getToolNames().length === 0) {
      throw new Error(
        `Failed to load any Letta tools for model "${resolvedModel}".`,
      );
    }
  }

  // Ensure base server memory tool is attached
  await ensureCorrectMemoryTool(agentId, resolvedModel);

  const toolsetName = deriveToolsetFromModel(resolvedModel);
  return toolsetName;
}
