import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelProviderType } from "@/agent/available-models";
import { resolveModel } from "@/agent/model";
import { resolveModelHandleFromLlmConfig } from "@/agent/model-handles";
import type { SkillSource } from "@/agent/skill-sources";
import { getBackend } from "@/backend";
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
import { LETTA_TOOLS } from "./letta-toolset";
import {
  clearToolsWithLock,
  filterBuiltInToolNamesByClientAllowlist,
  getInternalToolName,
  getToolNames,
  isOpenAIModel,
  loadSpecificTools,
  loadTools,
  type PreparedToolExecutionContext,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
} from "./manager";
import type { PermissionModeState } from "./permission-mode-state";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
} from "./toolset-defaults";
import type { ToolsetName, ToolsetPreference } from "./toolset-types";

export type { ToolsetName, ToolsetPreference } from "./toolset-types";

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
    case "letta":
      tools = [...LETTA_TOOLS];
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
 */
export async function forceToolsetSwitch(
  toolsetName: ToolsetName,
): Promise<void> {
  // Load the appropriate toolset
  // Note: loadTools/loadSpecificTools acquire a switch lock that causes
  // sendMessageStream to wait, preventing messages from being sent with
  // stale or partial tools during the switch.
  if (toolsetName === "none") {
    // Clear tools with lock protection so sendMessageStream() waits
    clearToolsWithLock();
  } else if (toolsetName === "codex") {
    await loadSpecificTools([...OPENAI_PASCAL_TOOLS]);
  } else if (toolsetName === "codex_snake") {
    await loadSpecificTools([...OPENAI_DEFAULT_TOOLS]);
  } else if (toolsetName === "gemini") {
    await loadSpecificTools([...GEMINI_PASCAL_TOOLS]);
  } else if (toolsetName === "gemini_snake") {
    await loadTools("google_ai/gemini-3-pro-preview");
  } else if (toolsetName === "letta") {
    await loadSpecificTools([...LETTA_TOOLS]);
  } else {
    await loadTools("anthropic/claude-sonnet-4");
  }
}

/**
 * Switches the loaded toolset based on the target model identifier.
 *
 * @param modelIdentifier - The model handle/id
 * @param providerType - Provider type used to refine toolset derivation
 */
export async function switchToolsetForModel(
  modelIdentifier: string,
  providerType?: string | null,
): Promise<ToolsetName> {
  // Resolve model ID to handle when possible so provider checks stay consistent
  const resolvedModel = resolveModel(modelIdentifier) ?? modelIdentifier;
  const typedToolsetName = deriveToolsetFromModel(resolvedModel, providerType);
  const stringOnlyToolsetName = deriveToolsetFromModel(resolvedModel);

  if (typedToolsetName !== stringOnlyToolsetName) {
    await forceToolsetSwitch(typedToolsetName);
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

  return typedToolsetName;
}
