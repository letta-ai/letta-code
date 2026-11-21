import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import stripAnsi from "strip-ansi";
import { getDisplayableToolReturn } from "@/agent/approval-execution";
import {
  getConversationId,
  getCurrentAgentId,
  getSkillSources,
  getSkillsDirectory,
} from "@/agent/context";
import { getModelInfo } from "@/agent/model";
import { getModelFacingSubagentDescriptors } from "@/agent/subagents";
import { getBackend } from "@/backend";
import { INTERRUPTED_BY_USER } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import { runPreToolUseHooks } from "@/hooks";
import { buildModInvocationContext } from "@/mods/context";
import { createModConversationHandle } from "@/mods/conversation-handle";
import { attachDeprecatedGetContextTrap } from "@/mods/deprecated-api";
import { emitModEvent, type ModEvents } from "@/mods/event-emitter";
import {
  checkModPermissions,
  getAvailableModPermissionsRegistry,
  type ModPermissionDecisionResult,
  type ModPermissionDefinition,
} from "@/mods/permission-registry";
import {
  getAvailableModToolsRegistry,
  getModToolDefinition,
  isModToolParallelSafe,
  type ModToolDefinition,
  runModTool,
} from "@/mods/tool-registry";
import type {
  ModContext,
  ModSecretResolver,
  ModToolEndEvent,
  ModToolRunContext,
  ModToolStartEvent,
} from "@/mods/types";
import { expandPathArgs } from "@/permissions/file-path-args";
import type {
  PermissionDecision,
  PermissionRuleType,
} from "@/permissions/types";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
  type RuntimeContextSnapshot,
  runWithRuntimeContext,
} from "@/runtime-context";
import { getRuntimeExecutionEnv } from "@/runtime-execution-settings";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { autoBackgroundClientTool } from "@/tools/client-tool-background";
import { listenerExternalToolBackgroundOptions } from "@/tools/external-tool-background-eligibility";
import { executeExternalToolRequest } from "@/tools/external-tool-execution";
import type {
  ClientTool,
  ExternalToolDefinition,
  ExternalToolExecutor,
} from "@/tools/external-tool-types";
import { autoBackgroundRemoteExternalTool } from "@/tools/remote-external-tool-background";
import * as contextRetention from "@/tools/tool-context-retention";

export type {
  ClientTool,
  ExternalToolDefinition,
  ExternalToolExecutor,
} from "@/tools/external-tool-types";

import { waitForToolCheckouts } from "@/utils/checkout-readiness";
import { debugLog } from "@/utils/debug";
import { refreshAndListSecrets } from "@/utils/secrets-store";
import { readSubagentDepth } from "@/utils/subagent-depth-env";
import { isRecord } from "@/utils/type-guards";
import {
  selectModelFacingExternalTools,
  serializeClientTools,
} from "./client-tool-serialization";
import { toolFilter } from "./filter";
import {
  appendHookFeedbackToText,
  appendHookFeedbackToToolReturn,
  collectPostToolHookFeedback,
} from "./hook-feedback";
import { clampToolReturnContent } from "./impl/tool-return-clamp";
import type { JsonSchema, ModelFacingToolForm } from "./model-facing-tool";
import {
  getEffectivePermissionModeState,
  type PermissionModeState,
} from "./permission-mode-state";
import {
  captureSecretRedactions,
  createScrubbedOutputStreamer,
  getAmbientRedactionSecrets,
  type InvocationSecretRedactions,
  resolveShellEnvironment,
  type ScrubbedOutputStreamer,
  sanitizeOutputLines,
  sanitizeToolReturnContent,
  scrubAmbientSecrets,
  scrubModToolLines,
  scrubModToolReturnContent,
  scrubModToolString,
  scrubSecretsFromString,
} from "./secret-substitution";
import {
  applySubagentToolPolicy,
  resolvedModelForm,
} from "./subagent-tool-policy";
import { resolveBackendSpecificToolAssets } from "./task-tool-assets";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";
import { getInternalToolName, getServerToolName } from "./tool-name-mapping";

export { getInternalToolName, getServerToolName };

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];

const STREAMING_SHELL_TOOLS = new Set([
  "Bash",
  "exec_command",
  "write_stdin",
  "Monitor",
  "Workflow",
]);
const SCOPED_BACKGROUND_TOOLS = new Set(["Monitor", "Workflow", "CodeMode"]);
const TOOL_CALL_ID_TOOLS = new Set(["Task", "Skill", "Monitor", "WatchPR"]);
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write"]);

function matchesClientToolAllowlistEntry(
  allowSet: Set<string> | null,
  serverToolName: string,
  internalToolName?: string,
): boolean {
  if (!allowSet) {
    return true;
  }

  return (
    allowSet.has(serverToolName) ||
    (internalToolName !== undefined && allowSet.has(internalToolName))
  );
}

function filterBuiltInToolNamesByClientAllowlist(
  toolNames: ToolName[],
  clientToolAllowlist?: string[],
): ToolName[] {
  if (clientToolAllowlist === undefined) {
    return toolNames;
  }

  const allowSet = new Set(clientToolAllowlist);
  return toolNames.filter((toolName) =>
    matchesClientToolAllowlistEntry(
      allowSet,
      getServerToolName(toolName),
      toolName,
    ),
  );
}

const ARTIFACT_TOOL_NAMES: ToolName[] = [
  "read_artifact_file",
  "write_artifact_file",
];

function shouldIncludeWorktreeTool(): boolean {
  try {
    return settingsManager.shouldIncludeWorktreeTool();
  } catch {
    return true;
  }
}

function filterWorktreeTools(toolNames: ToolName[]): ToolName[] {
  if (shouldIncludeWorktreeTool()) {
    return toolNames;
  }

  return toolNames.filter((name) => !WORKTREE_TOOL_NAMES.has(name));
}

function resolveArtifactToolNames(toolNames: ToolName[]): ToolName[] {
  const artifactToolSet = new Set<ToolName>(ARTIFACT_TOOL_NAMES);
  const withoutArtifactTools = toolNames.filter(
    (name) => !artifactToolSet.has(name),
  );

  if (!experimentManager.isEnabled("artifacts")) {
    return withoutArtifactTools;
  }

  return [...withoutArtifactTools, ...ARTIFACT_TOOL_NAMES];
}

function filterExternalToolsByClientAllowlist(
  externalTools: Map<string, ExternalToolDefinition>,
  clientToolAllowlist?: string[],
): Map<string, ExternalToolDefinition> {
  if (clientToolAllowlist === undefined) {
    return new Map(externalTools);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(externalTools.entries()).filter(([internalName, tool]) =>
      matchesClientToolAllowlistEntry(allowSet, tool.name, internalName),
    ),
  );
}

function filterToolRegistryByClientAllowlist(
  registry: ToolRegistry,
  clientToolAllowlist?: string[],
): ToolRegistry {
  if (clientToolAllowlist === undefined) {
    return new Map(registry);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(registry.entries()).filter(([internalName]) =>
      matchesClientToolAllowlistEntry(
        allowSet,
        getServerToolName(internalName),
        internalName,
      ),
    ),
  );
}

function filterMemoryToolByMemoryFormat(
  registry: ToolRegistry,
  agentId: string | null | undefined,
): ToolRegistry {
  if (!registry.has("Memory") || resolveMemoryToolDirectory(agentId)) {
    return registry;
  }
  const filtered = new Map(registry);
  filtered.delete("Memory");
  return filtered;
}

function filterExternalToolsByRuntimeContext(
  externalTools: Map<string, ExternalToolDefinition>,
  runtimeContext: RuntimeContextSnapshot,
): Map<string, ExternalToolDefinition> {
  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      const matchesRuntime =
        !tool.runtime ||
        ((tool.runtime.agentId ?? null) === (runtimeContext.agentId ?? null) &&
          tool.runtime.conversationId === runtimeContext.conversationId);
      const matchesConnection =
        tool.connectionId === undefined ||
        tool.connectionId === runtimeContext.connectionId ||
        tool.runtime !== undefined;
      return matchesRuntime && matchesConnection;
    }),
  );
}

function filterModToolsByClientAllowlist(
  modTools: Map<string, ModToolDefinition>,
  clientToolAllowlist?: string[],
): Map<string, ModToolDefinition> {
  if (clientToolAllowlist === undefined) {
    return new Map(modTools);
  }

  const allowSet = new Set(clientToolAllowlist);
  return new Map(
    Array.from(modTools.entries()).filter(([name, tool]) =>
      matchesClientToolAllowlistEntry(allowSet, tool.name, name),
    ),
  );
}

import { resolveMemoryToolDirectory } from "./impl/memory";
import { TOOLSET_CATALOG, WORKTREE_TOOL_NAMES } from "./toolset-catalog";
import type { ToolsetName } from "./toolset-types";

type ToolArgs = Record<string, unknown>;

interface ToolSchema {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

interface ToolDefinition {
  schema: ToolSchema;
  modelForm: ModelFacingToolForm;
  fn: (args: ToolArgs) => Promise<unknown>;
}

import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

export type ToolReturnContent = string | Array<TextContent | ImageContent>;

export type ToolExecutionResult = {
  toolReturn: ToolReturnContent;
  status: "success" | "error";
  stdout?: string[];
  stderr?: string[];
};

type ToolRegistry = Map<string, ToolDefinition>;

const REGISTRY_KEY = Symbol.for("@letta/toolRegistry");
const SWITCH_LOCK_KEY = Symbol.for("@letta/toolSwitchLock");
const EXECUTION_CONTEXTS_KEY = Symbol.for("@letta/toolExecutionContexts");

interface SwitchLockState {
  promise: Promise<void> | null;
  resolve: (() => void) | null;
  refCount: number;
}

type GlobalWithToolState = typeof globalThis & {
  [REGISTRY_KEY]?: ToolRegistry;
  [SWITCH_LOCK_KEY]?: SwitchLockState;
  [EXECUTION_CONTEXTS_KEY]?: Map<string, ToolExecutionContextSnapshot>;
};

function getRegistry(): ToolRegistry {
  const global = globalThis as GlobalWithToolState;
  if (!global[REGISTRY_KEY]) {
    global[REGISTRY_KEY] = new Map();
  }
  return global[REGISTRY_KEY];
}

function getSwitchLock(): SwitchLockState {
  const global = globalThis as GlobalWithToolState;
  if (!global[SWITCH_LOCK_KEY]) {
    global[SWITCH_LOCK_KEY] = { promise: null, resolve: null, refCount: 0 };
  }
  return global[SWITCH_LOCK_KEY];
}

const toolRegistry = getRegistry();
let startupCodeModeOnly = false;
let toolExecutionContextCounter = 0;

type ToolExecutionContextSnapshot = {
  shouldEnqueueBackground?: () => Promise<boolean>;
  toolRegistry: ToolRegistry;
  externalTools: Map<string, ExternalToolDefinition>;
  externalExecutor?: ExternalToolExecutor;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modPermissions: Map<string, ModPermissionDefinition>;
  modTools: Map<string, ModToolDefinition>;
  workingDirectory: string;
  runtimeContext: RuntimeContextSnapshot;
  permissionModeState: PermissionModeState;
};

export type CapturedToolExecutionContext = {
  contextId: string;
  clientTools: ClientTool[];
};

export type PreparedToolExecutionContext = CapturedToolExecutionContext & {
  loadedToolNames: string[];
};

function getExecutionContexts(): Map<string, ToolExecutionContextSnapshot> {
  const global = globalThis as GlobalWithToolState;
  if (!global[EXECUTION_CONTEXTS_KEY]) {
    global[EXECUTION_CONTEXTS_KEY] = new Map();
  }
  return global[EXECUTION_CONTEXTS_KEY];
}

function saveExecutionContext(snapshot: ToolExecutionContextSnapshot): string {
  const contexts = getExecutionContexts();
  const contextId = `ctx-${Date.now()}-${toolExecutionContextCounter++}`;
  contexts.set(contextId, snapshot);

  for (const id of contexts.keys()) {
    if (contexts.size <= 4096) break;
    if (!contextRetention.isToolContextRetained(id)) contexts.delete(id);
  }

  return contextId;
}

function buildExecutionRuntimeContextSnapshot(options?: {
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  runtimeContext?: Partial<RuntimeContextSnapshot>;
}): RuntimeContextSnapshot {
  const mergedScope: RuntimeContextSnapshot = {
    ...(getRuntimeContext() ?? {}),
    ...(options?.runtimeContext ?? {}),
  };

  if (mergedScope.agentId === undefined) {
    try {
      mergedScope.agentId = getCurrentAgentId();
    } catch {}
  }

  if (mergedScope.conversationId === undefined) {
    mergedScope.conversationId = getConversationId();
  }

  if (mergedScope.skillsDirectory === undefined) {
    mergedScope.skillsDirectory = getSkillsDirectory();
  }

  if (mergedScope.skillSources === undefined) {
    mergedScope.skillSources = getSkillSources();
  }

  mergedScope.workingDirectory =
    options?.workingDirectory ??
    mergedScope.workingDirectory ??
    getCurrentWorkingDirectory();
  mergedScope.permissionMode =
    options?.permissionModeState?.mode ?? mergedScope.permissionMode;

  return mergedScope;
}

export function getExecutionContextById(
  contextId: string,
): ToolExecutionContextSnapshot | undefined {
  return getExecutionContexts().get(contextId);
}

export function updateToolExecutionContextWorkingDirectory(
  contextId: string,
  workingDirectory: string,
): boolean {
  const context = getExecutionContextById(contextId);
  if (!context) {
    return false;
  }

  context.workingDirectory = workingDirectory;
  context.runtimeContext.workingDirectory = workingDirectory;
  return true;
}

export function getExecutionContextPermissionModeState(
  contextId: string,
): PermissionModeState | undefined {
  return getExecutionContextById(contextId)?.permissionModeState;
}

export function clearCapturedToolExecutionContexts(): void {
  getExecutionContexts().clear();
}

export function releaseToolExecutionContext(contextId: string): void {
  if (!contextRetention.deferToolContextRelease(contextId))
    getExecutionContexts().delete(contextId);
}

function acquireSwitchLock(): void {
  const lock = getSwitchLock();
  lock.refCount++;

  if (lock.refCount === 1) {
    lock.promise = new Promise((resolve) => {
      lock.resolve = resolve;
    });
  }
}

function releaseSwitchLock(): void {
  const lock = getSwitchLock();

  if (lock.refCount > 0) {
    lock.refCount--;
  }

  if (lock.refCount === 0 && lock.resolve) {
    lock.resolve();
    lock.promise = null;
    lock.resolve = null;
  }
}

export async function waitForToolsetReady(): Promise<void> {
  const lock = getSwitchLock();
  if (lock.promise) {
    await lock.promise;
  }
}

export function isToolsetSwitchInProgress(): boolean {
  return getSwitchLock().refCount > 0;
}

function resolveInternalToolName(
  name: string,
  registry: ToolRegistry = toolRegistry,
): string | undefined {
  if (registry.has(name)) {
    return name;
  }

  const internalName = getInternalToolName(name);
  if (registry.has(internalName)) {
    return internalName;
  }

  return undefined;
}

const EXTERNAL_TOOLS_KEY = Symbol.for("@letta/externalTools");
const EXTERNAL_EXECUTOR_KEY = Symbol.for("@letta/externalToolExecutor");

type GlobalWithExternalTools = typeof globalThis & {
  [EXTERNAL_TOOLS_KEY]?: Map<string, ExternalToolDefinition>;
  [EXTERNAL_EXECUTOR_KEY]?: ExternalToolExecutor;
};

function getExternalToolsRegistry(): Map<string, ExternalToolDefinition> {
  const global = globalThis as GlobalWithExternalTools;
  if (!global[EXTERNAL_TOOLS_KEY]) {
    global[EXTERNAL_TOOLS_KEY] = new Map();
  }
  return global[EXTERNAL_TOOLS_KEY];
}

export function registerExternalTools(tools: ExternalToolDefinition[]): void {
  const registry = getExternalToolsRegistry();
  for (const tool of tools) {
    registry.set(tool.registrationKey ?? tool.name, tool);
  }
}

export function unregisterExternalTools(tools: ExternalToolDefinition[]): void {
  const registry = getExternalToolsRegistry();
  for (const tool of tools) {
    const registrationKey = tool.registrationKey ?? tool.name;
    if (registry.get(registrationKey) === tool) {
      registry.delete(registrationKey);
    }
  }
}

export function setExternalToolExecutor(executor: ExternalToolExecutor): void {
  (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY] = executor;
}

function getExternalToolExecutor(): ExternalToolExecutor | undefined {
  return (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY];
}

export function clearExternalTools(): void {
  getExternalToolsRegistry().clear();
  delete (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY];
}

export function isExternalTool(name: string): boolean {
  return getExternalToolsRegistry().has(name);
}

export function getExternalToolDefinition(
  name: string,
): ExternalToolDefinition | undefined {
  return getExternalToolsRegistry().get(name);
}

export function getExternalToolsAsClientTools(): ClientTool[] {
  return Array.from(
    selectModelFacingExternalTools(
      filterExternalToolsByRuntimeContext(getExternalToolsRegistry(), {}),
    ).values(),
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

export async function executeExternalTool(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  executorOverride?: ExternalToolExecutor,
  toolDefinition?: ExternalToolDefinition,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  return executeExternalToolRequest(
    toolCallId,
    toolName,
    input,
    executorOverride ?? getExternalToolExecutor(),
    toolDefinition ?? getExternalToolDefinition(toolName),
    signal,
  );
}

export function getClientToolsFromRegistry(): ClientTool[] {
  return serializeClientTools(
    filterMemoryToolByMemoryFormat(toolRegistry, undefined),
    selectModelFacingExternalTools(
      filterExternalToolsByRuntimeContext(getExternalToolsRegistry(), {}),
    ),
    getAvailableModToolsRegistry(),
    getServerToolName,
    startupCodeModeOnly,
  );
}

function capturePreparedToolExecutionContext(
  snapshot: {
    toolRegistry: ToolRegistry;
    externalTools: Map<string, ExternalToolDefinition>;
    externalExecutor?: ExternalToolExecutor;
    modContext?: ModContext;
    modEvents?: ModEvents;
    modPermissions: Map<string, ModPermissionDefinition>;
    modTools: Map<string, ModToolDefinition>;
  },
  options?: {
    clientToolAllowlist?: string[];
    externalToolOwnerConnectionId?: string;
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    modContext?: ModContext;
    modEvents?: ModEvents;
    runtimeContext?: Partial<RuntimeContextSnapshot>;
    codeModeOnly?: boolean;
  },
): PreparedToolExecutionContext {
  const runtimeContext = buildExecutionRuntimeContextSnapshot(options);
  const clientToolAllowlist =
    options?.clientToolAllowlist ?? toolFilter.getEnabledTools() ?? undefined;
  const toolRegistrySnapshot = filterMemoryToolByMemoryFormat(
    applySubagentToolPolicy(
      filterToolRegistryByClientAllowlist(
        snapshot.toolRegistry,
        clientToolAllowlist,
      ),
      readSubagentDepth(
        getRuntimeExecutionEnv(process.env, runtimeContext.executionSettings),
      ),
    ),
    runtimeContext.agentId,
  );
  const executionSnapshot: ToolExecutionContextSnapshot = {
    toolRegistry: toolRegistrySnapshot,
    externalTools: selectModelFacingExternalTools(
      filterExternalToolsByClientAllowlist(
        filterExternalToolsByRuntimeContext(
          snapshot.externalTools,
          runtimeContext,
        ),
        clientToolAllowlist,
      ),
      options?.externalToolOwnerConnectionId ?? runtimeContext.connectionId,
    ),
    externalExecutor: snapshot.externalExecutor,
    modContext: options?.modContext ?? snapshot.modContext,
    modEvents: options?.modEvents ?? snapshot.modEvents,
    modPermissions: snapshot.modPermissions,
    modTools: filterModToolsByClientAllowlist(
      snapshot.modTools,
      clientToolAllowlist,
    ),
    workingDirectory:
      runtimeContext.workingDirectory ?? getCurrentWorkingDirectory(),
    runtimeContext,
    permissionModeState: getEffectivePermissionModeState(
      options?.permissionModeState,
    ),
  };
  const clientTools = serializeClientTools(
    executionSnapshot.toolRegistry,
    executionSnapshot.externalTools,
    executionSnapshot.modTools,
    getServerToolName,
    options?.codeModeOnly,
  );
  executionSnapshot.runtimeContext.clientToolNames = clientTools.map(
    (tool) => tool.name,
  );
  const contextId = saveExecutionContext(executionSnapshot);
  executionSnapshot.runtimeContext.toolContextId = contextId;
  executionSnapshot.runtimeContext.resolveMcpOriginatorSuperRunId = () =>
    executionSnapshot.runtimeContext.mcpOriginatorSuperRunId;
  return {
    contextId,
    clientTools,
    loadedToolNames: serializeClientTools(
      executionSnapshot.toolRegistry,
      new Map(),
      executionSnapshot.modTools,
      getServerToolName,
      options?.codeModeOnly,
    ).map((tool) => tool.name),
  };
}

export function captureToolExecutionContext(
  workingDirectory: string = getCurrentWorkingDirectory(),
  permissionModeState?: PermissionModeState,
  modContext?: ModContext,
): CapturedToolExecutionContext {
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: new Map(toolRegistry),
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext,
      modPermissions: getAvailableModPermissionsRegistry(modContext),
      modTools: getAvailableModToolsRegistry(modContext),
    },
    {
      workingDirectory,
      permissionModeState,
      modContext,
      codeModeOnly: startupCodeModeOnly,
    },
  );
}

export async function prepareCurrentToolExecutionContext(options?: {
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  runtimeContext?: Partial<RuntimeContextSnapshot>;
  modContext?: ModContext;
  modEvents?: ModEvents;
  modPermissions?: Map<string, ModPermissionDefinition>;
  modTools?: Map<string, ModToolDefinition>;
}): Promise<PreparedToolExecutionContext> {
  await waitForToolsetReady();
  const currentToolNames = Array.from(toolRegistry.keys()) as ToolName[];
  const toolRegistrySnapshot = await buildToolRegistry(
    currentToolNames,
    options?.workingDirectory,
  );
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: toolRegistrySnapshot,
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext: options?.modContext,
      modEvents: options?.modEvents,
      modPermissions:
        options?.modPermissions ??
        getAvailableModPermissionsRegistry(options?.modContext),
      modTools:
        options?.modTools ?? getAvailableModToolsRegistry(options?.modContext),
    },
    { ...options, codeModeOnly: startupCodeModeOnly },
  );
}

export async function prepareToolExecutionContextForSpecificTools(
  toolNames: string[],
  options?: {
    clientToolAllowlist?: string[];
    externalToolOwnerConnectionId?: string;
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    modContext?: ModContext;
    modEvents?: ModEvents;
    modPermissions?: Map<string, ModPermissionDefinition>;
    modTools?: Map<string, ModToolDefinition>;
    runtimeContext?: Partial<RuntimeContextSnapshot>;
  },
): Promise<PreparedToolExecutionContext> {
  const toolRegistrySnapshot = await buildToolRegistry(
    toolNames,
    options?.workingDirectory,
  );
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: toolRegistrySnapshot,
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext: options?.modContext,
      modEvents: options?.modEvents,
      modPermissions:
        options?.modPermissions ??
        getAvailableModPermissionsRegistry(options?.modContext),
      modTools:
        options?.modTools ?? getAvailableModToolsRegistry(options?.modContext),
    },
    options,
  );
}

type ModelToolsetOptions = {
  resolvedToolset?: ToolsetName;
  exclude?: ToolName[];
  include?: ToolName[];
  clientToolAllowlist?: string[];
};

export async function prepareToolExecutionContextForModel(
  modelIdentifier?: string,
  options?: ModelToolsetOptions & {
    externalToolOwnerConnectionId?: string;
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    modContext?: ModContext;
    modEvents?: ModEvents;
    modPermissions?: Map<string, ModPermissionDefinition>;
    modTools?: Map<string, ModToolDefinition>;
    runtimeContext?: Partial<RuntimeContextSnapshot>;
  },
): Promise<PreparedToolExecutionContext> {
  const toolRegistrySnapshot = await buildRegistryForModel(
    modelIdentifier,
    options,
  );
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: toolRegistrySnapshot,
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext: options?.modContext,
      modEvents: options?.modEvents,
      modPermissions:
        options?.modPermissions ??
        getAvailableModPermissionsRegistry(options?.modContext),
      modTools:
        options?.modTools ?? getAvailableModToolsRegistry(options?.modContext),
    },
    { ...options, codeModeOnly: options?.resolvedToolset === "codemode" },
  );
}

export function isModToolParallelSafeForContext(
  toolName: string,
  contextId?: string,
): boolean {
  const context = contextId ? getExecutionContextById(contextId) : undefined;
  return isModToolParallelSafe(
    toolName,
    context?.modTools ?? getAvailableModToolsRegistry(),
  );
}

async function checkModPermissionForContext(options: {
  args: ToolArgs;
  context?: ToolExecutionContextSnapshot;
  phase: "approval" | "execution";
  toolCallId?: string | null;
  toolName: string;
  workingDirectory: string;
}): Promise<ModPermissionDecisionResult | undefined> {
  const runtimeContext = options.context?.runtimeContext;
  const permissionModeState = options.context?.permissionModeState;
  const modContext =
    options.context?.modContext ??
    buildModInvocationContext({
      conversationId: runtimeContext?.conversationId ?? null,
      permissionMode:
        permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
      workingDirectory: options.workingDirectory,
    });
  return checkModPermissions(
    {
      agentId: runtimeContext?.agentId ?? null,
      conversationId: runtimeContext?.conversationId ?? null,
      toolCallId: options.toolCallId ?? null,
      toolName: options.toolName,
      args: options.args,
      cwd: options.workingDirectory,
      workingDirectory: options.workingDirectory,
      permissionMode:
        permissionModeState?.mode ?? runtimeContext?.permissionMode ?? null,
      phase: options.phase,
    },
    options.context?.modPermissions ??
      getAvailableModPermissionsRegistry(modContext),
    modContext,
  );
}

export async function checkToolPermission(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory?: string,
  permissionModeStateArg?: PermissionModeState,
  agentIdArg?: string,
  toolContextIdArg?: string | null,
  toolCallIdArg?: string | null,
): Promise<{
  decision: PermissionDecision;
  matchedRule?: string;
  reason?: string;
}> {
  const { checkPermissionWithHooks } = await import("@/permissions/checker");
  const { loadPermissions } = await import("@/permissions/loader");

  const context = toolContextIdArg
    ? getExecutionContextById(toolContextIdArg)
    : undefined;
  const effectiveWorkingDirectory =
    workingDirectory ?? context?.workingDirectory ?? process.cwd();
  const effectivePermissionModeState =
    permissionModeStateArg ?? context?.permissionModeState;
  const effectiveAgentId =
    agentIdArg ?? context?.runtimeContext.agentId ?? undefined;
  const modContext =
    context?.modContext ??
    buildModInvocationContext({
      conversationId: context?.runtimeContext.conversationId ?? null,
      permissionMode: effectivePermissionModeState?.mode ?? null,
      workingDirectory: effectiveWorkingDirectory,
    });
  const permissions = await loadPermissions(effectiveWorkingDirectory);
  return runWithRuntimeContext(
    {
      ...(context?.runtimeContext ?? {}),
      ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
      workingDirectory: effectiveWorkingDirectory,
      permissionMode: effectivePermissionModeState?.mode,
    },
    () =>
      checkPermissionWithHooks(
        toolName,
        toolArgs,
        permissions,
        effectiveWorkingDirectory,
        effectivePermissionModeState,
        effectiveAgentId,
        context?.modPermissions ??
          getAvailableModPermissionsRegistry(modContext),
        context?.modTools ?? getAvailableModToolsRegistry(modContext),
        {
          conversationId: context?.runtimeContext.conversationId ?? null,
          modContext,
          phase: "approval",
          toolCallId: toolCallIdArg ?? null,
        },
      ),
  );
}

export async function savePermissionRule(
  rule: string,
  ruleType: PermissionRuleType,
  scope: "project" | "local" | "user" | "session",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  if (scope === "session") {
    const { sessionPermissions } = await import("@/permissions/session");
    sessionPermissions.addRule(rule, ruleType);
    return;
  }

  const { savePermissionRule: save } = await import("@/permissions/loader");
  await save(rule, ruleType, scope, workingDirectory);
}

export async function analyzeToolApproval(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<import("@/permissions/analyzer").ApprovalContext> {
  const { analyzeApprovalContext } = await import("@/permissions/analyzer");
  return analyzeApprovalContext(toolName, toolArgs, workingDirectory);
}

function replaceRegistry(newTools: ToolRegistry): void {
  toolRegistry.clear();
  for (const [key, value] of newTools) {
    toolRegistry.set(key, value);
  }
}

function maybeApplyLspReadOverride(registry: ToolRegistry): void {
  if (!process.env.LETTA_ENABLE_LSP || !registry.has("Read")) {
    return;
  }

  const lspDefinition = TOOL_DEFINITIONS.ReadLSP;
  if (!lspDefinition) {
    return;
  }

  registry.set("Read", {
    schema: {
      name: "Read",
      description: lspDefinition.description,
      input_schema: lspDefinition.schema,
    },
    modelForm: lspDefinition.modelForm,
    fn: lspDefinition.impl,
  });
}

async function buildToolRegistry(
  toolNames: readonly string[],
  workingDirectory = getCurrentWorkingDirectory(),
): Promise<ToolRegistry> {
  const newRegistry: ToolRegistry = new Map();

  for (const name of toolNames) {
    const internalName = getInternalToolName(name);
    const enabledTools = toolFilter.getEnabledTools();
    if (
      enabledTools !== null &&
      !enabledTools.some(
        (allowed) => getInternalToolName(allowed) === internalName,
      )
    ) {
      continue;
    }
    if (
      !shouldIncludeWorktreeTool() &&
      WORKTREE_TOOL_NAMES.has(internalName as ToolName)
    ) {
      continue;
    }
    const definition = TOOL_DEFINITIONS[internalName as ToolName];
    if (!definition) {
      console.warn(
        `Tool ${name} (internal: ${internalName}) not found in definitions, skipping`,
      );
      continue;
    }

    if (!definition.impl) {
      throw new Error(`Tool implementation not found for ${internalName}`);
    }

    const resolvedAssets = await resolveBackendSpecificToolAssets(
      internalName,
      definition.description,
      definition.schema as JsonSchema,
    );
    let { description } = resolvedAssets;
    const { inputSchema } = resolvedAssets;
    if (internalName === "Task") {
      const subagents =
        await getModelFacingSubagentDescriptors(workingDirectory);
      description = injectSubagentsIntoTaskDescription(description, subagents);
    }

    const toolSchema: ToolSchema = {
      name: internalName,
      description,
      input_schema: inputSchema,
    };

    newRegistry.set(internalName, {
      schema: toolSchema,
      modelForm: resolvedModelForm(
        definition.modelForm,
        description,
        inputSchema,
      ),
      fn: definition.impl,
    });
  }

  maybeApplyLspReadOverride(newRegistry);
  return newRegistry;
}

function resolveBaseToolNamesForModel(
  modelIdentifier?: string,
  options?: ModelToolsetOptions,
): ToolName[] {
  const modelToolset =
    modelIdentifier && isOpenAIModel(modelIdentifier) ? "codex" : "default";
  const toolset = options?.resolvedToolset ?? modelToolset;
  // CodeMode uses the same permission-filtered registry as direct tool calls.
  const registryToolset = toolset === "codemode" ? modelToolset : toolset;
  const allowlist =
    options?.clientToolAllowlist ?? toolFilter.getEnabledTools();
  const allowlistedTools = (allowlist ?? [])
    .map(getInternalToolName)
    .filter((name): name is ToolName => Object.hasOwn(TOOL_DEFINITIONS, name));
  let toolNames = resolveArtifactToolNames([
    ...new Set([
      ...TOOLSET_CATALOG[registryToolset].tools,
      ...(options?.include ?? []),
      ...allowlistedTools,
    ]),
  ]);
  if (options?.exclude) {
    const excluded = new Set(options.exclude);
    toolNames = toolNames.filter((name) => !excluded.has(name));
  }
  return filterBuiltInToolNamesByClientAllowlist(
    filterWorktreeTools(toolNames),
    options?.clientToolAllowlist,
  );
}

async function buildRegistryForModel(
  modelIdentifier?: string,
  options?: ModelToolsetOptions & { workingDirectory?: string },
): Promise<ToolRegistry> {
  return buildToolRegistry(
    resolveBaseToolNamesForModel(modelIdentifier, options),
    options?.workingDirectory,
  );
}

export async function loadSpecificTools(toolNames: string[]): Promise<void> {
  acquireSwitchLock();

  try {
    const newRegistry = await buildToolRegistry(toolNames);
    replaceRegistry(newRegistry);
    startupCodeModeOnly = false;
  } finally {
    releaseSwitchLock();
  }
}

export async function loadTools(
  modelIdentifier?: string,
  options?: ModelToolsetOptions,
): Promise<void> {
  acquireSwitchLock();

  try {
    const newRegistry = await buildRegistryForModel(modelIdentifier, options);
    replaceRegistry(newRegistry);
    startupCodeModeOnly = options?.resolvedToolset === "codemode";
  } finally {
    releaseSwitchLock();
  }
}

export function isOpenAIModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return (
      info.handle.startsWith("openai/") ||
      info.handle.startsWith("openai-codex/") ||
      info.handle.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`) ||
      info.handle.startsWith("chatgpt_oauth/")
    );
  }
  return (
    modelIdentifier.startsWith("openai/") ||
    modelIdentifier.startsWith("openai-codex/") ||
    modelIdentifier.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`) ||
    modelIdentifier.startsWith("chatgpt_oauth/")
  );
}

function injectSubagentsIntoTaskDescription(
  baseDescription: string,
  subagents: Array<{
    name: string;
    description: string;
    recommendedModel: string;
  }>,
): string {
  if (subagents.length === 0) {
    return baseDescription;
  }

  const agentsSection = subagents
    .map((agent) => {
      return `### ${agent.name}
- **Purpose**: ${agent.description}
- **Recommended model**: ${agent.recommendedModel}`;
    })
    .join("\n\n");

  const usageMarker = "## Usage";
  const usageIndex = baseDescription.indexOf(usageMarker);

  if (usageIndex === -1) {
    return `${baseDescription}\n\n## Available Agents\n\n${agentsSection}`;
  }

  const before = baseDescription.slice(0, usageIndex);
  const after = baseDescription.slice(usageIndex);

  return `${before}## Available Agents\n\n${agentsSection}\n\n${after}`;
}

export function clipToolReturn(
  text: string,
  maxLines: number = 3,
  maxChars: number = 300,
): string {
  if (!text) return text;

  if (text.includes("request to call tool denied")) {
    return text;
  }

  let clipped = text;
  if (text.length > maxChars) {
    clipped = text.slice(0, maxChars);
  }

  const lines = clipped.split("\n");
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join("\n");
  }

  if (text.length > maxChars || lines.length > maxLines) {
    const lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      clipped = clipped.slice(0, lastSpace);
    }
    clipped += "…";
  }

  return clipped;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isMultimodalContent(
  arr: unknown[],
): arr is Array<TextContent | ImageContent> {
  return arr.every(
    (item) => isRecord(item) && (item.type === "text" || item.type === "image"),
  );
}

const MOD_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

function normalizeModSecretName(name: string): string {
  const normalized = name.toUpperCase();
  if (!MOD_SECRET_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid secret name '${name}'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.`,
    );
  }
  return normalized;
}

function createScrubbedError(error: unknown, message: string): Error {
  const scrubbedError = new Error(message);
  if (error instanceof Error) {
    scrubbedError.name = error.name;
  }
  return scrubbedError;
}

function createModSecretResolver(options: {
  addRedaction: (name: string, value: string) => void;
  agentId: string | null | undefined;
}): ModSecretResolver {
  let agentSecretsPromise: Promise<Record<string, string>> | null = null;

  const loadAgentSecrets = async (): Promise<Record<string, string>> => {
    if (!options.agentId) return {};
    agentSecretsPromise ??= refreshAndListSecrets(options.agentId).then(
      (entries) =>
        Object.fromEntries(entries.map(({ key, value }) => [key, value])),
    );
    return agentSecretsPromise;
  };

  return async (name, resolverOptions) => {
    const key = normalizeModSecretName(name);
    let agentLookupError: unknown;

    if (options.agentId) {
      try {
        const agentSecrets = await loadAgentSecrets();
        if (Object.hasOwn(agentSecrets, key)) {
          const value = agentSecrets[key] ?? "";
          options.addRedaction(key, value);
          return value;
        }
      } catch (error) {
        agentLookupError = error;
      }
    }

    if (resolverOptions?.envFallback === true) {
      const value = process.env[key];
      if (value !== undefined) {
        options.addRedaction(key, value);
        return value;
      }
    }

    if (agentLookupError !== undefined) {
      throw agentLookupError;
    }

    return null;
  };
}

function flattenToolResponse(result: unknown): ToolReturnContent {
  if (result === null || result === undefined) {
    return "";
  }

  if (typeof result === "string") {
    return result;
  }

  if (Array.isArray(result) && isMultimodalContent(result)) {
    return result;
  }

  if (!isRecord(result)) {
    return JSON.stringify(result);
  }

  if (typeof result.message === "string") {
    const keys = Object.keys(result);
    if (keys.length > 1) {
      return JSON.stringify(result);
    }
    return result.message;
  }

  if (Array.isArray(result.content) && isMultimodalContent(result.content)) {
    return result.content;
  }

  if (typeof result.content === "string") {
    return result.content;
  }

  if (Array.isArray(result.content)) {
    const textContent = result.content
      .filter(
        (item): item is { type: string; text: string } =>
          isRecord(item) &&
          item.type === "text" &&
          typeof item.text === "string",
      )
      .map((item) => item.text)
      .join("\n");

    if (textContent) {
      return textContent;
    }
  }

  if (typeof result.output === "string") {
    return result.output;
  }

  if (Array.isArray(result.files)) {
    const files = result.files.filter(
      (file): file is string => typeof file === "string",
    );
    if (files.length === 0) {
      return "No files found";
    }
    return `Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`;
  }

  if (typeof result.killed === "boolean") {
    return result.killed
      ? "Process killed successfully"
      : "Failed to kill process (may have already exited)";
  }

  if (typeof result.error === "string") {
    return result.error;
  }

  if (Array.isArray(result.todos)) {
    return `Updated ${result.todos.length} todo${result.todos.length !== 1 ? "s" : ""}`;
  }

  return JSON.stringify(result);
}

function createLinkedAbortSignal(signals: Array<AbortSignal | undefined>): {
  cleanup: () => void;
  signal: AbortSignal;
} {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  );
  const controller = new AbortController();
  const cleanupFns: Array<() => void> = [];
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
    cleanupFns.push(() => signal.removeEventListener("abort", abort));
  }

  return {
    cleanup: () => {
      for (const cleanup of cleanupFns) {
        cleanup();
      }
    },
    signal: controller.signal,
  };
}

function getModToolStatus(result: unknown): "success" | "error" {
  if (!isRecord(result)) return "success";
  if (result.status === "error" || result.isError === true) return "error";
  if (result.success === false) return "error";
  return "success";
}

function cloneToolArgsForModEvent(args: ToolArgs): ToolArgs {
  try {
    return structuredClone(args);
  } catch {
    return { ...args };
  }
}

function createModPermissionToolResult(
  decision: ModPermissionDecisionResult,
): ToolExecutionResult {
  const isApprovalRequest =
    decision.decision === "ask" || decision.decision === "alwaysAsk";
  const action = isApprovalRequest ? "blocked" : "denied";
  const fallbackReason = isApprovalRequest
    ? "Approval requested but cannot reopen during execution."
    : "No reason given.";
  return {
    toolReturn: `Error: Tool execution ${action} by ${decision.matchedRule}. ${decision.reason ?? fallbackReason}`,
    status: "error",
  };
}

function isToolStartArgs(value: unknown): value is ToolArgs {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function emitToolStartEvent(options: {
  args: ToolArgs;
  events?: ModEvents;
  executionScope: RuntimeContextSnapshot;
  modContext: ModContext;
  toolCallId?: string;
  toolName: string;
}): Promise<{
  args: ToolArgs;
  result?: { status: "success" | "error"; output: string };
}> {
  const event: ModToolStartEvent & {
    result?: { status: "success" | "error"; output: string };
  } = {
    agentId: options.executionScope.agentId ?? null,
    conversationId: options.executionScope.conversationId ?? null,
    toolCallId: options.toolCallId ?? null,
    toolName: options.toolName,
    args: cloneToolArgsForModEvent(options.args),
  };

  try {
    await emitModEvent(options.events, "tool_start", event, options.modContext);
  } catch (error) {
    debugLog("mods", "tool_start event failed", error);
    return { args: options.args };
  }

  return {
    args: isToolStartArgs(event.args) ? event.args : options.args,
    result: event.result,
  };
}

async function emitToolEndEvent(options: {
  args: ToolArgs;
  events?: ModEvents;
  executionScope: RuntimeContextSnapshot;
  modContext: ModContext;
  toolCallId?: string;
  toolName: string;
  status: "success" | "error";
  output: string;
}): Promise<{ status: "success" | "error"; output: string } | undefined> {
  const event: ModToolEndEvent & {
    result?: { status: "success" | "error"; output: string };
  } = {
    agentId: options.executionScope.agentId ?? null,
    conversationId: options.executionScope.conversationId ?? null,
    toolCallId: options.toolCallId ?? null,
    toolName: options.toolName,
    args: cloneToolArgsForModEvent(options.args),
    status: options.status,
    output: options.output,
  };

  try {
    await emitModEvent(options.events, "tool_end", event, options.modContext);
  } catch (error) {
    debugLog("mods", "tool_end event failed", error);
    return undefined;
  }

  return event.result;
}

async function executeModTool(
  toolName: string,
  tool: ModToolDefinition,
  args: ToolArgs,
  executionScope: RuntimeContextSnapshot,
  options: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    workingDirectory: string;
    scopedAgentId?: string;
    modContext?: ModContext;
  },
): Promise<ToolExecutionResult> {
  const startTime = Date.now();
  const linkedSignal = createLinkedAbortSignal([
    options.signal,
    tool.activationSignal,
  ]);
  const { signal } = linkedSignal;
  const redactions: InvocationSecretRedactions = new Map(
    Object.entries(getAmbientRedactionSecrets(options.scopedAgentId)),
  );
  const addRedaction = (name: string, value: string): void => {
    if (value.length > 0) {
      redactions.set(name, value);
    }
  };

  const run = async (): Promise<ToolExecutionResult> => {
    const preHookResult = await runPreToolUseHooks(
      toolName,
      args as Record<string, unknown>,
      options.toolCallId,
      options.workingDirectory,
      options.scopedAgentId,
    );
    if (preHookResult.blocked) {
      const feedback = preHookResult.feedback.join("\n") || "Blocked by hook";
      return {
        toolReturn: `Error: Tool execution blocked by hook. ${scrubAmbientSecrets(feedback)}`,
        status: "error",
      };
    }

    try {
      const backend = getBackend();
      const modContext = toolExecutionModContext(executionScope, options);
      const context: ModToolRunContext = {
        ...modContext,
        args: args as Record<string, unknown>,
        toolCallId: options.toolCallId ?? null,
        signal,
        secret: createModSecretResolver({
          addRedaction,
          agentId: modContext.agent.id,
        }),
        ...(options.onOutput
          ? {
              onOutput: (chunk: string, stream: "stdout" | "stderr") => {
                options.onOutput?.(
                  stripAnsi(scrubModToolString(chunk, redactions)),
                  stream,
                );
              },
            }
          : {}),
        conversation: createModConversationHandle({
          agentId: executionScope.agentId,
          backend,
          conversationId: executionScope.conversationId,
          sendMessageStream: async (...sendArgs) => {
            const { sendMessageStreamWithBackend } = await import(
              "@/agent/message"
            );
            const [backend, conversationId, messages, opts, requestOptions] =
              sendArgs;
            const agentId =
              opts?.agentId ?? executionScope.agentId ?? undefined;
            return sendMessageStreamWithBackend(
              backend,
              conversationId,
              messages,
              { ...opts, agentId },
              requestOptions,
            );
          },
          workingDirectory: options.workingDirectory,
        }),
      };
      const result = await runModTool(
        tool,
        attachDeprecatedGetContextTrap(
          context,
          tool.recordDiagnostic,
          "ctx.getContext",
        ),
      );
      const duration = Date.now() - startTime;
      const recordResult = isRecord(result) ? result : undefined;
      const stdout = scrubModToolLines(
        isStringArray(recordResult?.stdout) ? recordResult.stdout : undefined,
        redactions,
      );
      const stderr = scrubModToolLines(
        isStringArray(recordResult?.stderr) ? recordResult.stderr : undefined,
        redactions,
      );
      const toolStatus = getModToolStatus(result);
      const flattenedResponse = clampToolReturnContent(
        scrubModToolReturnContent(flattenToolResponse(result), redactions),
        toolName,
      );
      const responseSize =
        typeof flattenedResponse === "string"
          ? flattenedResponse.length
          : JSON.stringify(flattenedResponse).length;

      telemetry.trackToolUsage(
        toolName,
        toolStatus === "success",
        duration,
        responseSize,
        toolStatus === "error" ? "tool_error" : undefined,
        stderr ? stderr.join("\n") : undefined,
      );

      const hookFeedback = await collectPostToolHookFeedback(
        {
          args: args as Record<string, unknown>,
          debugLabel: "mod tool result path",
          scopedAgentId: options.scopedAgentId,
          toolCallId: options.toolCallId,
          toolName,
          workingDirectory: options.workingDirectory,
        },
        {
          status: toolStatus,
          output: getDisplayableToolReturn(flattenedResponse),
          failureOutput:
            typeof flattenedResponse === "string"
              ? flattenedResponse
              : JSON.stringify(flattenedResponse),
          errorType: "tool_error",
        },
      );
      const finalToolReturn = appendHookFeedbackToToolReturn(
        flattenedResponse,
        hookFeedback,
      );

      return {
        toolReturn: finalToolReturn,
        status: toolStatus,
        ...(stdout && { stdout }),
        ...(stderr && { stderr }),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const isAbort =
        signal.aborted ||
        (error instanceof Error &&
          (error.name === "AbortError" ||
            error.message === "The operation was aborted" ||
            ("code" in error && error.code === "ABORT_ERR")));
      const errorType = isAbort
        ? "abort"
        : error instanceof Error
          ? error.name
          : "unknown";
      const errorMessage = scrubModToolString(
        isAbort
          ? INTERRUPTED_BY_USER
          : error instanceof Error
            ? error.message
            : String(error),
        redactions,
      );

      tool.recordDiagnostic?.({
        capability: { id: toolName, kind: "tool" },
        error: createScrubbedError(error, errorMessage),
        phase: "tool.run",
      });

      telemetry.trackToolUsage(
        toolName,
        false,
        duration,
        errorMessage.length,
        errorType,
        errorMessage,
      );

      const hookFeedback = await collectPostToolHookFeedback(
        {
          args: args as Record<string, unknown>,
          debugLabel: "mod tool exception path",
          scopedAgentId: options.scopedAgentId,
          toolCallId: options.toolCallId,
          toolName,
          workingDirectory: options.workingDirectory,
        },
        {
          status: "error",
          output: errorMessage,
          failureOutput: errorMessage,
          errorType,
        },
      );
      const finalErrorMessage = appendHookFeedbackToText(
        errorMessage,
        hookFeedback,
      );

      return {
        toolReturn: finalErrorMessage,
        status: "error",
      };
    }
  };

  try {
    return await runWithRuntimeContext(executionScope, run);
  } finally {
    linkedSignal.cleanup();
  }
}

function toolExecutionModContext(
  executionScope: RuntimeContextSnapshot,
  options: { workingDirectory: string; modContext?: ModContext },
): ModContext {
  return buildModInvocationContext({
    agent: { id: executionScope.agentId ?? null },
    base: options.modContext,
    conversationId: executionScope.conversationId ?? null,
    permissionMode: executionScope.permissionMode ?? null,
    workingDirectory: options.workingDirectory,
  });
}

async function executeToolInner(
  name: string,
  args: ToolArgs,
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    onFileWrite?: (filePath: string, content: string) => void;
    toolEndArgsRef?: { current: ToolArgs };
  },
): Promise<ToolExecutionResult> {
  const context = options?.toolContextId
    ? getExecutionContextById(options.toolContextId)
    : undefined;
  if (options?.toolContextId && !context) {
    return {
      toolReturn: `Tool execution context not found: ${options.toolContextId}`,
      status: "error",
    };
  }
  const activeRegistry = context?.toolRegistry ?? toolRegistry;
  const activeExternalTools =
    context?.externalTools ?? getExternalToolsRegistry();
  const activeExternalExecutor =
    context?.externalExecutor ?? getExternalToolExecutor();
  const modEvents = context?.modEvents;
  const executionScope = context?.runtimeContext
    ? buildExecutionRuntimeContextSnapshot({
        workingDirectory: context.runtimeContext.workingDirectory ?? undefined,
        permissionModeState: context.permissionModeState,
        runtimeContext: context.runtimeContext,
      })
    : buildExecutionRuntimeContextSnapshot({
        workingDirectory: context?.workingDirectory,
        permissionModeState: context?.permissionModeState,
      });
  const backgroundOptions = {
    shouldEnqueue: context?.shouldEnqueueBackground,
    runtimeScope: executionScope,
    signal: options?.signal,
    onOutput: options?.onOutput,
  };
  const workingDirectory =
    executionScope.workingDirectory ?? getCurrentWorkingDirectory();
  const scopedAgentId = executionScope.agentId ?? undefined;
  const modContext =
    context?.modContext ??
    toolExecutionModContext(executionScope, { workingDirectory });
  const activeModTools =
    context?.modTools ?? getAvailableModToolsRegistry(modContext);
  try {
    if (!activeExternalTools.has(name) || activeModTools.has(name))
      await waitForToolCheckouts(
        scopedAgentId,
        name,
        args,
        workingDirectory,
        activeModTools.has(name),
      );
  } catch (error) {
    return {
      status: "error",
      toolReturn: `Memory checkout is unavailable: ${String(error)}`,
    };
  }

  if (activeModTools.has(name)) {
    const modTool = activeModTools.get(name);
    if (!modTool) {
      return {
        toolReturn: `Mod tool not found: ${name}`,
        status: "error",
      };
    }
    const { args: eventArgs, result } = await emitToolStartEvent({
      args,
      events: modEvents,
      executionScope,
      modContext,
      toolCallId: options?.toolCallId,
      toolName: name,
    });
    if (result) {
      if (options?.toolEndArgsRef) options.toolEndArgsRef.current = eventArgs;
      return {
        toolReturn: result.output,
        status: result.status,
      };
    }
    if (options?.toolEndArgsRef) options.toolEndArgsRef.current = eventArgs;
    const permissionDecision = await checkModPermissionForContext({
      args: eventArgs,
      context,
      phase: "execution",
      toolCallId: options?.toolCallId,
      toolName: name,
      workingDirectory,
    });
    if (permissionDecision?.decision !== undefined) {
      if (permissionDecision.decision !== "allow") {
        return createModPermissionToolResult(permissionDecision);
      }
    }
    return autoBackgroundClientTool(
      name,
      (signal, onOutput) =>
        executeModTool(name, modTool, eventArgs, executionScope, {
          signal,
          toolCallId: options?.toolCallId,
          onOutput,
          workingDirectory,
          scopedAgentId,
          modContext,
        }),
      backgroundOptions,
      modEvents,
    );
  }
  if (activeExternalTools.has(name)) {
    const externalTool = activeExternalTools.get(name);
    const { args: eventArgs, result } = await emitToolStartEvent({
      args,
      events: modEvents,
      executionScope,
      modContext,
      toolCallId: options?.toolCallId,
      toolName: name,
    });
    if (result) {
      if (options?.toolEndArgsRef) options.toolEndArgsRef.current = eventArgs;
      return { toolReturn: result.output, status: result.status };
    }
    if (options?.toolEndArgsRef) options.toolEndArgsRef.current = eventArgs;
    const permissionDecision = await checkModPermissionForContext({
      args: eventArgs,
      context,
      phase: "execution",
      toolCallId: options?.toolCallId,
      toolName: name,
      workingDirectory,
    });
    if (
      permissionDecision?.decision !== undefined &&
      permissionDecision.decision !== "allow"
    ) {
      return createModPermissionToolResult(permissionDecision);
    }
    if (externalTool?.executor && externalTool.autoBackground === undefined) {
      return runWithRuntimeContext(executionScope, () =>
        autoBackgroundClientTool(
          name,
          (signal) =>
            executeExternalTool(
              options?.toolCallId ?? `ext-${Date.now()}`,
              name,
              eventArgs as Record<string, unknown>,
              externalTool.executor,
              externalTool,
              signal,
            ),
          backgroundOptions,
          modEvents,
        ),
      );
    }
    return runWithRuntimeContext(executionScope, () =>
      autoBackgroundRemoteExternalTool(
        name,
        externalTool,
        executeExternalTool.bind(
          null,
          options?.toolCallId ?? `ext-${Date.now()}`,
          name,
          eventArgs as Record<string, unknown>,
          externalTool?.executor ?? activeExternalExecutor,
          externalTool,
        ),
        listenerExternalToolBackgroundOptions(
          externalTool,
          modEvents,
          executionScope,
          options?.signal,
        ),
      ),
    );
  }
  const internalName = resolveInternalToolName(name, activeRegistry);
  const tool = internalName ? activeRegistry.get(internalName) : undefined;
  if (!internalName || !tool) {
    const availableTools = [
      ...Array.from(activeRegistry.keys()),
      ...Array.from(activeExternalTools.keys()),
      ...Array.from(activeModTools.keys()),
    ];
    return {
      toolReturn: `Tool not found: ${name}. Available tools: ${availableTools.join(", ")}`,
      status: "error",
    };
  }

  const { args: eventArgs, result } = await emitToolStartEvent({
    args,
    events: modEvents,
    executionScope,
    modContext,
    toolCallId: options?.toolCallId,
    toolName: internalName,
  });
  if (result) {
    if (options?.toolEndArgsRef) options.toolEndArgsRef.current = eventArgs;
    return {
      toolReturn: result.output,
      status: result.status,
    };
  }
  args = eventArgs;
  if (options?.toolEndArgsRef) options.toolEndArgsRef.current = args;
  const permissionDecision = await checkModPermissionForContext({
    args,
    context,
    phase: "execution",
    toolCallId: options?.toolCallId,
    toolName: internalName,
    workingDirectory,
  });
  if (permissionDecision?.decision !== undefined) {
    if (permissionDecision.decision !== "allow") {
      return createModPermissionToolResult(permissionDecision);
    }
  }
  const startTime = Date.now();

  const run = async (
    signal: AbortSignal,
    onOutput: NonNullable<typeof options>["onOutput"],
  ): Promise<ToolExecutionResult> => {
    const preHookResult = await runPreToolUseHooks(
      internalName,
      args as Record<string, unknown>,
      options?.toolCallId,
      workingDirectory,
      scopedAgentId,
    );
    if (preHookResult.blocked) {
      const feedback = preHookResult.feedback.join("\n") || "Blocked by hook";
      return {
        toolReturn: `Error: Tool execution blocked by hook. ${scrubAmbientSecrets(feedback)}`,
        status: "error",
      };
    }

    if (preHookResult.updatedInput) {
      args = {
        ...(args as Record<string, unknown>),
        ...preHookResult.updatedInput,
      };
    }
    if (options?.toolEndArgsRef) options.toolEndArgsRef.current = args;

    let invocationSecrets: Record<string, string> = {};
    let invocationRedactions = captureSecretRedactions(scopedAgentId);
    let outputStreamer: ScrubbedOutputStreamer | null = null;

    try {
      let enhancedArgs = expandPathArgs(internalName, args, workingDirectory);

      enhancedArgs = { ...enhancedArgs, signal };

      if (STREAMING_SHELL_TOOLS.has(internalName)) {
        const command = enhancedArgs.command ?? enhancedArgs.cmd;
        const environment = await resolveShellEnvironment(
          command,
          scopedAgentId,
        );
        invocationSecrets = environment.secretEnv;
        invocationRedactions = captureSecretRedactions(
          scopedAgentId,
          invocationSecrets,
        );
        if (onOutput) {
          outputStreamer = createScrubbedOutputStreamer(
            invocationRedactions,
            onOutput,
            stripAnsi,
          );
          enhancedArgs = { ...enhancedArgs, onOutput: outputStreamer.onOutput };
        }
        enhancedArgs = { ...enhancedArgs, ...environment };
      }
      const parentScope =
        options?.parentScope ??
        (SCOPED_BACKGROUND_TOOLS.has(internalName) && scopedAgentId
          ? {
              agentId: scopedAgentId,
              conversationId: executionScope.conversationId ?? "default",
            }
          : undefined);
      if (
        parentScope &&
        (STREAMING_SHELL_TOOLS.has(internalName) ||
          ["Task", "Skill", "CodeMode"].includes(internalName))
      ) {
        enhancedArgs = { ...enhancedArgs, parentScope };
      }

      if (
        internalName === "AskUserQuestionAsync" ||
        (TOOL_CALL_ID_TOOLS.has(internalName) && options?.toolCallId)
      ) {
        enhancedArgs = { ...enhancedArgs, toolCallId: options?.toolCallId };
      }
      if (WORKTREE_TOOL_NAMES.has(internalName as ToolName)) {
        enhancedArgs = {
          ...enhancedArgs,
          ...(options?.toolContextId && {
            _executionContextId: options.toolContextId,
          }),
        };
      }

      const result = await tool
        .fn(enhancedArgs)
        .finally(() => outputStreamer?.flush());
      const duration = Date.now() - startTime;

      if (options?.onFileWrite && FILE_MUTATING_TOOLS.has(internalName)) {
        const filePath = (enhancedArgs as Record<string, unknown>).file_path as
          | string
          | undefined;
        if (filePath) {
          try {
            const resolvedPath = nodePath.isAbsolute(filePath)
              ? filePath
              : nodePath.resolve(workingDirectory, filePath);
            const content = await nodeFs.readFile(resolvedPath, "utf-8");
            options.onFileWrite(resolvedPath, content);
          } catch {}
        }
      }

      const recordResult = isRecord(result) ? result : undefined;
      const stdoutValue = recordResult?.stdout;
      const stderrValue = recordResult?.stderr;
      const stdout = isStringArray(stdoutValue) ? stdoutValue : undefined;
      const stderr = isStringArray(stderrValue) ? stderrValue : undefined;

      const toolStatus = recordResult?.status === "error" ? "error" : "success";

      let flattenedResponse = flattenToolResponse(result);

      const stripAnsiEscapes = STREAMING_SHELL_TOOLS.has(internalName);
      flattenedResponse = sanitizeToolReturnContent(
        flattenedResponse,
        invocationRedactions,
        stripAnsiEscapes,
      );
      if (stdout)
        sanitizeOutputLines(stdout, invocationRedactions, stripAnsiEscapes);
      if (stderr)
        sanitizeOutputLines(stderr, invocationRedactions, stripAnsiEscapes);

      flattenedResponse = clampToolReturnContent(
        flattenedResponse,
        internalName,
      );

      const responseSize =
        typeof flattenedResponse === "string"
          ? flattenedResponse.length
          : JSON.stringify(flattenedResponse).length;
      telemetry.trackToolUsage(
        internalName,
        toolStatus === "success",
        duration,
        responseSize,
        toolStatus === "error" ? "tool_error" : undefined,
        stderr ? stderr.join("\n") : undefined,
      );

      const hookFeedback = await collectPostToolHookFeedback(
        {
          args: args as Record<string, unknown>,
          debugLabel: "tool result path",
          scopedAgentId,
          toolCallId: options?.toolCallId,
          toolName: internalName,
          workingDirectory,
        },
        {
          status: toolStatus,
          output: getDisplayableToolReturn(flattenedResponse),
          failureOutput:
            typeof flattenedResponse === "string"
              ? flattenedResponse
              : JSON.stringify(flattenedResponse),
          errorType: "tool_error",
        },
      );
      const finalToolReturn = appendHookFeedbackToToolReturn(
        flattenedResponse,
        hookFeedback,
      );

      return {
        toolReturn: finalToolReturn,
        status: toolStatus,
        ...(stdout && { stdout }),
        ...(stderr && { stderr }),
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const isAbort =
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.message === "The operation was aborted" ||
          ("code" in error && error.code === "ABORT_ERR"));
      const errorType = isAbort
        ? "abort"
        : error instanceof Error
          ? error.name
          : "unknown";
      const errorMessage = isAbort
        ? INTERRUPTED_BY_USER
        : scrubSecretsFromString(
            error instanceof Error ? error.message : String(error),
            invocationRedactions,
          );

      telemetry.trackToolUsage(
        internalName,
        false,
        duration,
        errorMessage.length,
        errorType,
        errorMessage,
      );

      const hookFeedback = await collectPostToolHookFeedback(
        {
          args: args as Record<string, unknown>,
          debugLabel: "tool exception path",
          scopedAgentId,
          toolCallId: options?.toolCallId,
          toolName: internalName,
          workingDirectory,
        },
        {
          status: "error",
          output: errorMessage,
          failureOutput: errorMessage,
          errorType,
        },
      );
      const finalErrorMessage = appendHookFeedbackToText(
        errorMessage,
        hookFeedback,
      );

      return {
        toolReturn: finalErrorMessage,
        status: "error",
      };
    }
  };

  return runWithRuntimeContext(executionScope, () =>
    autoBackgroundClientTool(internalName, run, backgroundOptions, modEvents),
  );
}

export async function executeTool(
  ...params: Parameters<typeof executeToolInner>
): Promise<ToolExecutionResult> {
  const [name, args, options] = params;
  const toolEndArgsRef = { current: args };
  const preRunAgentId = options?.toolContextId
    ? getExecutionContextById(options.toolContextId)?.runtimeContext?.agentId
    : undefined;
  const preRunRedactions = captureSecretRedactions(preRunAgentId);
  const res = await executeToolInner(name, args, {
    ...options,
    toolEndArgsRef,
  });

  const context = options?.toolContextId
    ? getExecutionContextById(options.toolContextId)
    : undefined;
  const modEvents = context?.modEvents;
  if (!modEvents || typeof res.toolReturn !== "string") {
    return res;
  }

  const executionScope = context?.runtimeContext
    ? buildExecutionRuntimeContextSnapshot({
        workingDirectory: context.runtimeContext.workingDirectory ?? undefined,
        permissionModeState: context.permissionModeState,
        runtimeContext: context.runtimeContext,
      })
    : buildExecutionRuntimeContextSnapshot({
        workingDirectory: context?.workingDirectory,
        permissionModeState: context?.permissionModeState,
      });
  const modContext =
    context?.modContext ??
    toolExecutionModContext(executionScope, {
      workingDirectory:
        executionScope.workingDirectory ?? getCurrentWorkingDirectory(),
    });

  const overrideRedactions = captureSecretRedactions(
    executionScope.agentId ?? undefined,
    preRunRedactions,
  );
  const override = await emitToolEndEvent({
    args: toolEndArgsRef.current,
    events: modEvents,
    executionScope,
    modContext,
    toolCallId: options?.toolCallId,
    toolName: name,
    status: res.status,
    output: res.toolReturn,
  });

  return override
    ? {
        ...res,
        toolReturn: scrubSecretsFromString(override.output, overrideRedactions),
        status: override.status,
      }
    : res;
}

export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

export function getAllLettaToolNames(): string[] {
  return [...TOOL_NAMES];
}

export function getToolSchemas(): ToolSchema[] {
  const builtInSchemas = Array.from(toolRegistry.values()).map(
    (tool) => tool.schema,
  );
  const modSchemas = Array.from(getAvailableModToolsRegistry().values()).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as JsonSchema,
    }),
  );
  return [...builtInSchemas, ...modSchemas];
}

export function getToolSchema(
  name: string,
  toolContextId?: string | null,
): ToolSchema | undefined {
  const context = toolContextId
    ? getExecutionContextById(toolContextId)
    : undefined;
  const registry = context?.toolRegistry ?? toolRegistry;
  const internalName = resolveInternalToolName(name, registry);
  if (internalName) {
    return registry.get(internalName)?.schema;
  }
  const modTool = context?.modTools.get(name) ?? getModToolDefinition(name);
  if (modTool) {
    return {
      name: modTool.name,
      description: modTool.description,
      input_schema: modTool.parameters as JsonSchema,
    };
  }
  const externalTool =
    context?.externalTools.get(name) ?? getExternalToolDefinition(name);
  if (externalTool) {
    return {
      name: externalTool.name,
      description: externalTool.description,
      input_schema: externalTool.parameters as JsonSchema,
    };
  }
  return undefined;
}

export function clearTools(): void {
  toolRegistry.clear();
}
