import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelProviderType } from "@/agent/available-models";
import { resolveModel } from "@/agent/model";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import type { SkillSource } from "@/agent/skill-sources";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { buildModInvocationContext } from "@/mods/context";
import type { ModEvents } from "@/mods/event-emitter";
import type { ModAdapter } from "@/mods/mod-adapter";
import type { ModPermissionDefinition } from "@/mods/permission-registry";
import type { ModToolDefinition } from "@/mods/tool-registry";
import type { ModContext } from "@/mods/types";
import type { RuntimeContextSnapshot } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { isRecord } from "@/utils/type-guards";
import {
  getInternalToolName,
  isOpenAIModel,
  loadTools,
  type PreparedToolExecutionContext,
  prepareToolExecutionContextForModel,
} from "./manager";
import type { PermissionModeState } from "./permission-mode-state";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";
import type { ToolsetName, ToolsetPreference } from "./toolset-types";

export type { ToolsetName, ToolsetPreference } from "./toolset-types";

// Server-side memory tool names that can mutate memory blocks.
// When memfs is enabled, we detach ALL of these from the agent.
export const MEMORY_TOOL_NAMES = new Set([
  "memory",
  "memory_apply_patch",
  "memory_insert",
  "memory_replace",
  "memory_rethink",
]);

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

/** Startup uses the same preset selection and construction as each turn. */
export async function loadStartupTools(params: {
  modelIdentifier?: string;
  toolset?: ToolsetPreference;
  exclude?: ToolName[];
}): Promise<void> {
  const { modelIdentifier, toolset = "auto", exclude } = params;
  await loadTools(modelIdentifier, {
    resolvedToolset:
      toolset === "auto"
        ? deriveToolsetFromModel(modelIdentifier ?? "")
        : toolset,
    exclude,
  });
}

type ScopeModelCarrier = Partial<
  Pick<AgentState, "model" | "llm_config" | "model_settings">
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

type ModelTarget = {
  model: string | null;
  providerType: string | null;
};

function normalizeModelHandle(model: string | null | undefined): string | null {
  return model && model.length > 0 ? (resolveModel(model) ?? model) : null;
}

function modelTargetFromCarrier(
  carrier: ScopeModelCarrier | null | undefined,
): ModelTarget {
  return {
    model: normalizeModelHandle(getPreferredAgentModelHandle(carrier)),
    providerType: providerTypeFromModelSettings(carrier?.model_settings),
  };
}

function providerForMatchingModel(
  model: string,
  targets: ModelTarget[],
): string | null {
  for (const target of targets) {
    if (target.model === model && target.providerType) {
      return target.providerType;
    }
  }
  return null;
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
    clientToolAllowlist: inputToolAllowlist,
    externalToolScopeIds,
    workingDirectory,
    permissionModeState,
    modContext,
    modEvents,
    modAdapters,
    runtimeContext,
    agent,
  } = params;
  const launchTools = runtimeContext?.executionSettings?.tools;
  const clientToolAllowlist =
    launchTools === undefined
      ? inputToolAllowlist
      : inputToolAllowlist === undefined
        ? launchTools
        : launchTools.filter((name) =>
            inputToolAllowlist.some(
              (allowed) =>
                getInternalToolName(allowed) === getInternalToolName(name),
            ),
          );
  const effectiveModel =
    modelIdentifier && modelIdentifier.length > 0
      ? (resolveModel(modelIdentifier) ?? modelIdentifier)
      : null;
  const effectiveToolsetPreference = clientToolset?.base ?? toolsetPreference;
  const includedToolNames = resolveIncludedToolNames(clientToolset?.include);

  const resolvedToolset =
    effectiveToolsetPreference === "auto"
      ? deriveToolsetFromModel(effectiveModel ?? "", providerType)
      : effectiveToolsetPreference;

  const scopedModContext = buildModInvocationContext({
    agent,
    base: modContext,
    conversationId,
    modelIdentifier: effectiveModel,
    permissionMode:
      permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
    toolset: resolvedToolset,
    workingDirectory,
  });
  const modCapabilities = mergeModAdapterCapabilities(
    modAdapters,
    scopedModContext,
  );
  const preparedToolContext = await prepareToolExecutionContextForModel(
    effectiveModel ?? undefined,
    {
      resolvedToolset,
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
    toolset: resolvedToolset,
    toolsetPreference,
    effectiveModel,
    agent: null,
  };
}

export async function prepareToolExecutionContextForScope(params: {
  connectionId?: string;
  environmentDeviceId?: string;
  agentId: string | null;
  conversationId?: string | null;
  actingUserId?: string;
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
  workspaceSandbox?: RuntimeContextSnapshot["workspaceSandbox"];
  executionSettings?: RuntimeContextSnapshot["executionSettings"];
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
    actingUserId,
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
    workspaceSandbox,
    executionSettings,
    cachedAgent,
    modContext,
    modEvents,
    modAdapters,
  } = params;

  const backend = getBackend();
  const agent = agentId
    ? ((cachedAgent ??
        (await backend.retrieveAgent(agentId))) as ScopeModelCarrier)
    : null;
  const agentTarget = modelTargetFromCarrier(agent);
  const conversationTarget =
    conversationId && conversationId !== "default"
      ? modelTargetFromCarrier(
          (await backend.retrieveConversation(
            conversationId,
          )) as ScopeModelCarrier,
        )
      : { model: null, providerType: null };

  const explicitModel = normalizeModelHandle(overrideModel);
  const cachedModel = normalizeModelHandle(cachedEffectiveModel);
  const effectiveModel =
    explicitModel ??
    cachedModel ??
    conversationTarget.model ??
    agentTarget.model;
  let effectiveProviderType = explicitModel
    ? (overrideProviderType ??
      providerForMatchingModel(explicitModel, [
        conversationTarget,
        agentTarget,
      ]))
    : cachedModel
      ? providerForMatchingModel(cachedModel, [conversationTarget, agentTarget])
      : conversationTarget.model
        ? conversationTarget.providerType
        : agentTarget.providerType;

  const toolsetPreference = (() => {
    try {
      return settingsManager.getToolsetPreference(
        agentId ?? conversationId ?? "agent-free",
        conversationId ?? "default",
      );
    } catch {
      return "auto" as const;
    }
  })();
  const effectiveToolsetPreference = clientToolset?.base ?? toolsetPreference;

  if (
    effectiveModel &&
    !effectiveProviderType &&
    effectiveToolsetPreference === "auto"
  ) {
    try {
      effectiveProviderType =
        (await getModelProviderType(effectiveModel)) ?? null;
    } catch {
      // Model metadata is best-effort. Handle-based classification remains
      // available when the provider inventory cannot be fetched.
    }
  }

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
    agent: agent as AgentState | null,
    runtimeContext: {
      connectionId,
      environmentDeviceId,
      agentId,
      agentName: (agent as AgentState | null)?.name ?? null,
      conversationId: scopedConversationId,
      ...(actingUserId ? { actingUserId } : {}),
      workingDirectory,
      ...(skillsDirectory !== undefined ? { skillsDirectory } : {}),
      ...(skillSources !== undefined ? { skillSources } : {}),
      ...(workspaceSandbox !== undefined ? { workspaceSandbox } : {}),
      executionSettings,
    },
  });
  return { ...result, agent: agent as AgentState | null };
}

/**
 * Ensures the server-side memory tool is attached to the agent.
 * Client toolsets may use memory_apply_patch, but server-side base memory tool remains memory.
 *
 * This is a server-side tool swap - client tools are passed via client_tools per-request.
 *
 * @param agentId - The agent ID to update
 */
export async function ensureCorrectMemoryTool(agentId: string): Promise<void> {
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
  await loadTools(undefined, { resolvedToolset: toolsetName });
  if (toolsetName !== "none") await ensureCorrectMemoryTool(agentId);
}

/**
 * Switches the loaded toolset based on the target model identifier,
 * and ensures the correct memory tool is attached to the agent.
 *
 * @param modelIdentifier - The model handle/id
 * @param agentId - Agent to relink tools to
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  agentId: string,
  providerType?: string | null,
): Promise<ToolsetName> {
  const toolset = deriveToolsetFromModel(modelIdentifier, providerType);
  await forceToolsetSwitch(toolset, agentId);
  return toolset;
}
