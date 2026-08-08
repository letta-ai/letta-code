import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { resolveModel } from "@/agent/model";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import type { SkillSource } from "@/agent/skill-sources";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { experimentManager } from "@/experiments/manager";
import { buildModInvocationContext } from "@/mods/context";
import type { ModEvents } from "@/mods/event-emitter";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModPermissionDefinition } from "@/mods/permission-registry";
import type { ModToolDefinition } from "@/mods/tool-registry";
import type { ModContext } from "@/mods/types";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";
import { toolFilter } from "./filter";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  clearToolsWithLock,
  filterBuiltInToolNamesByClientAllowlist,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  getInternalToolName,
  getToolNames,
  isOpenAIModel,
  loadSpecificTools,
  loadTools,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
  type PreparedToolExecutionContext,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";
import type { PermissionModeState } from "./permission-mode-state";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";

// Toolset definitions from manager.ts (single source of truth)

const ARTIFACT_TOOL_NAMES: ToolName[] = [
  "read_artifact_file",
  "write_artifact_file",
];

function appendArtifactToolsIfEnabled(toolNames: ToolName[]): ToolName[] {
  const artifactToolSet = new Set<ToolName>(ARTIFACT_TOOL_NAMES);
  const withoutArtifactTools = toolNames.filter(
    (name) => !artifactToolSet.has(name),
  );
  if (!experimentManager.isEnabled("artifacts")) {
    return withoutArtifactTools;
  }
  return [...withoutArtifactTools, ...ARTIFACT_TOOL_NAMES];
}
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

export interface ClientToolsetConfig {
  /** Request-scoped base toolset. Omitted preserves the runtime preference. */
  base?: ToolsetPreference;
  /** Additional bundled client tools to load before applying the allowlist. */
  include?: string[];
}

function resolveIncludedToolNames(toolNames: string[] | undefined): ToolName[] {
  if (!toolNames) return [];

  return toolNames.map((toolName) => {
    const internalName = getInternalToolName(toolName);
    if (!Object.hasOwn(TOOL_DEFINITIONS, internalName)) {
      throw new Error(`Unknown bundled client tool: ${toolName}`);
    }
    return internalName as ToolName;
  });
}

/**
 * Bundled client tools named in the allowlist, so that allowlisting a tool
 * also loads it. Without this an allowlist is only a filter over whatever the
 * base happens to carry, so a client asking for exactly ["Read", "LS",
 * "Glob", "Grep"] silently gets just the ones its base already had.
 *
 * Unknown names are skipped rather than rejected: unlike `include`, an
 * allowlist legitimately carries MCP and other external tool names that are
 * not bundled client tools.
 */
function resolveAllowlistedToolNames(
  allowlist: string[] | undefined,
): ToolName[] {
  if (!allowlist) return [];

  const toolNames: ToolName[] = [];
  for (const allowedName of allowlist) {
    const internalName = getInternalToolName(allowedName);
    if (Object.hasOwn(TOOL_DEFINITIONS, internalName)) {
      toolNames.push(internalName as ToolName);
    }
  }
  return toolNames;
}

function appendUniqueToolNames(
  baseToolNames: ToolName[],
  includedToolNames: ToolName[],
): ToolName[] {
  const result = [...baseToolNames];
  const seen = new Set(result);
  for (const toolName of includedToolNames) {
    if (!seen.has(toolName)) {
      result.push(toolName);
      seen.add(toolName);
    }
  }
  return result;
}

export function deriveToolsetFromModel(
  modelIdentifier: string,
  providerType?: string | null,
): "codex" | "default" {
  if (providerType === "chatgpt_oauth" || providerType === "openai-codex") {
    return "codex";
  }
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  return isOpenAIModel(resolvedModel) ? "codex" : "default";
}

type ScopeModelCarrier = Pick<
  AgentState,
  "model" | "llm_config" | "model_settings"
>;

function providerTypeFromModelSettings(modelSettings: unknown): string | null {
  if (!isRecord(modelSettings)) return null;
  const providerType = modelSettings.provider_type;
  return typeof providerType === "string" ? providerType : null;
}

export type PreparedScopeToolContext = {
  preparedToolContext: PreparedToolExecutionContext;
  toolset: ToolsetName;
  toolsetPreference: ToolsetPreference;
  effectiveModel: string | null;
  agent: AgentState | null;
};

function mergeModAdapterCapabilities(
  adapters: ModAdapter[] | undefined,
  context: ModContext,
): {
  permissions?: Map<string, ModPermissionDefinition>;
  tools?: Map<string, ModToolDefinition>;
} {
  if (!adapters) return {};

  const permissions = new Map<string, ModPermissionDefinition>();
  const tools = new Map<string, ModToolDefinition>();
  for (const adapter of adapters) {
    for (const [id, permission] of adapter.getAvailablePermissions(context)) {
      permissions.set(id, permission);
    }
    for (const [name, tool] of adapter.getAvailableTools(context)) {
      tools.set(name, tool);
    }
  }
  return { permissions, tools };
}

function getPreferredAgentModelHandle(
  agent: ScopeModelCarrier | null | undefined,
): string | null {
  if (!agent) return null;
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  return resolveModelHandleFromLlmConfig(agent.llm_config);
}

function getToolNamesForToolset(toolsetName: ToolsetName): ToolName[] {
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
      tools = [];
      break;
    default:
      tools = [...ANTHROPIC_DEFAULT_TOOLS];
      break;
  }

  return appendArtifactToolsIfEnabled(tools);
}

export async function prepareToolExecutionContextForResolvedTarget(params: {
  modelIdentifier?: string | null;
  providerType?: string | null;
  conversationId?: string | null;
  toolsetPreference: ToolsetPreference;
  clientToolset?: ClientToolsetConfig;
  exclude?: ToolName[];
  clientToolAllowlist?: string[];
  externalToolScopeIds?: string[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modAdapters?: ModAdapter[];
  runtimeContext?: Partial<RuntimeContextSnapshot>;
  agent?: AgentState | null;
}): Promise<PreparedScopeToolContext> {
  const {
    modelIdentifier,
    providerType,
    conversationId,
    toolsetPreference,
    clientToolset,
    exclude,
    clientToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    modContext,
    modEvents,
    modAdapters,
    runtimeContext,
    agent,
  } = params;
  const effectiveModel =
    modelIdentifier && modelIdentifier.length > 0
      ? (resolveModel(modelIdentifier) ?? modelIdentifier)
      : null;
  const effectiveToolsetPreference = clientToolset?.base ?? toolsetPreference;
  const includedToolNames = appendUniqueToolNames(
    resolveIncludedToolNames(clientToolset?.include),
    resolveAllowlistedToolNames(clientToolAllowlist),
  );

  if (effectiveToolsetPreference === "auto") {
    const derivedToolset = effectiveModel
      ? deriveToolsetFromModel(effectiveModel, providerType)
      : "default";
    const scopedModContext = buildModInvocationContext({
      agent,
      base: modContext,
      conversationId,
      modelIdentifier: effectiveModel,
      permissionMode:
        permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
      toolset: derivedToolset,
      workingDirectory,
    });
    const modCapabilities = mergeModAdapterCapabilities(
      modAdapters,
      scopedModContext,
    );
    const preparedToolContext = await prepareToolExecutionContextForModel(
      effectiveModel ?? undefined,
      {
        resolvedToolset: derivedToolset,
        exclude,
        include: includedToolNames,
        clientToolAllowlist,
        externalToolScopeIds,
        workingDirectory,
        permissionModeState,
        modContext: scopedModContext,
        modEvents,
        modPermissions: modCapabilities.permissions,
        modTools: modCapabilities.tools,
        runtimeContext,
      },
    );

    return {
      preparedToolContext,
      toolset: derivedToolset,
      toolsetPreference,
      effectiveModel,
      agent: null,
    };
  }

  const scopedModContext = buildModInvocationContext({
    agent,
    base: modContext,
    conversationId,
    modelIdentifier: effectiveModel,
    permissionMode:
      permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
    toolset: effectiveToolsetPreference,
    workingDirectory,
  });
  const modCapabilities = mergeModAdapterCapabilities(
    modAdapters,
    scopedModContext,
  );
  const preparedToolContext = await prepareToolExecutionContextForSpecificTools(
    filterBuiltInToolNamesByClientAllowlist(
      appendUniqueToolNames(
        getToolNamesForToolset(effectiveToolsetPreference),
        includedToolNames,
      ).filter((toolName) => (exclude ? !exclude.includes(toolName) : true)),
      clientToolAllowlist,
    ),
    {
      clientToolAllowlist,
      externalToolScopeIds,
      workingDirectory,
      permissionModeState,
      modContext: scopedModContext,
      modEvents,
      modPermissions: modCapabilities.permissions,
      modTools: modCapabilities.tools,
      runtimeContext,
    },
  );

  return {
    preparedToolContext,
    toolset: effectiveToolsetPreference,
    toolsetPreference,
    effectiveModel,
    agent: null,
  };
}

export async function prepareToolExecutionContextForScope(params: {
  connectionId?: string;
  environmentDeviceId?: string;
  agentId: string;
  conversationId?: string | null;
  overrideModel?: string | null;
  overrideProviderType?: string | null;
  cachedEffectiveModel?: string | null;
  exclude?: ToolName[];
  clientToolset?: ClientToolsetConfig;
  clientToolAllowlist?: string[];
  externalToolScopeIds?: string[];
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  skillsDirectory?: string;
  skillSources?: SkillSource[];
  cachedAgent?: AgentState | null;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modAdapters?: ModAdapter[];
}): Promise<PreparedScopeToolContext> {
  const {
    connectionId,
    environmentDeviceId,
    agentId,
    conversationId,
    overrideModel,
    overrideProviderType,
    cachedEffectiveModel,
    exclude,
    clientToolset,
    clientToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    skillsDirectory,
    skillSources,
    cachedAgent,
    modContext,
    modEvents,
    modAdapters,
  } = params;

  const backend = getBackend();
  const agent = (cachedAgent ??
    (await backend.retrieveAgent(agentId))) as ScopeModelCarrier;
  let effectiveModel =
    overrideModel && overrideModel.length > 0
      ? (resolveModel(overrideModel) ?? overrideModel)
      : null;
  let effectiveProviderType =
    overrideProviderType !== undefined
      ? overrideProviderType
      : providerTypeFromModelSettings(
          (agent as { model_settings?: unknown }).model_settings,
        );

  if (
    !effectiveModel &&
    cachedEffectiveModel &&
    cachedEffectiveModel.length > 0
  ) {
    effectiveModel = resolveModel(cachedEffectiveModel) ?? cachedEffectiveModel;
  }

  if (!effectiveModel && conversationId && conversationId !== "default") {
    const conversation = await backend.retrieveConversation(conversationId);
    const conversationModel = (conversation as { model?: string | null }).model;
    if (typeof conversationModel === "string" && conversationModel.length > 0) {
      effectiveModel = resolveModel(conversationModel) ?? conversationModel;
    }
    effectiveProviderType =
      providerTypeFromModelSettings(
        (conversation as { model_settings?: unknown }).model_settings,
      ) ?? effectiveProviderType;
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

  const scopedConversationId = conversationId ?? "default";

  const result = await prepareToolExecutionContextForResolvedTarget({
    modelIdentifier: effectiveModel,
    providerType: effectiveProviderType,
    conversationId: conversationId ?? undefined,
    toolsetPreference,
    clientToolset,
    exclude,
    clientToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    modContext,
    modEvents,
    modAdapters,
    agent: agent as AgentState,
    runtimeContext: {
      connectionId,
      environmentDeviceId,
      agentId,
      agentName: (agent as AgentState).name ?? null,
      conversationId: scopedConversationId,
      workingDirectory,
      ...(skillsDirectory !== undefined ? { skillsDirectory } : {}),
      ...(skillSources !== undefined ? { skillSources } : {}),
    },
  });
  return { ...result, agent: agent as AgentState };
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
  if (!getBackend().capabilities.serverSideToolManagement) {
    return;
  }
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
  if (!getBackend().capabilities.serverSideToolManagement) {
    return false;
  }
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
  cachedAgent?: AgentState | null,
): Promise<{ removedToolNames: string[] } | null> {
  const backend = getBackend();

  try {
    const agentWithTools = (cachedAgent ??
      (await backend.retrieveAgent(agentId, {
        include: ["agent.tools"],
      }))) as AgentWithToolsAndRules;
    if (!shouldClearPersistedToolRules(agentWithTools)) {
      return null;
    }
    const existingRules = agentWithTools.tool_rules || [];

    await backend.updateAgent(agentId, {
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
  providerType?: string | null,
): Promise<ToolsetName> {
  // Resolve model ID to handle when possible so provider checks stay consistent
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  const typedToolsetName = deriveToolsetFromModel(resolvedModel, providerType);
  const stringOnlyToolsetName = deriveToolsetFromModel(resolvedModel);

  if (typedToolsetName !== stringOnlyToolsetName) {
    await forceToolsetSwitch(typedToolsetName, agentId);
    return typedToolsetName;
  }

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

  return typedToolsetName;
}
