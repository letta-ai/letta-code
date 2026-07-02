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
import { getAllSubagentConfigs } from "@/agent/subagents";
import { getBackend } from "@/backend";
import {
  buildDynamicMessageChannelToolDefinition,
  getCachedDynamicMessageChannelToolDefinition,
  type MessageChannelToolDiscoveryScope,
} from "@/channels/message-tool";
import { getActiveChannelIds } from "@/channels/registry";
import type { ChannelTurnSource } from "@/channels/types";
import { INTERRUPTED_BY_USER } from "@/constants";
import { experimentManager } from "@/experiments/manager";
import {
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
} from "@/hooks";
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
  modToolApprovalPolicy,
  runModTool,
} from "@/mods/tool-registry";
import type {
  ModContext,
  ModSecretResolver,
  ModToolEndEvent,
  ModToolRunContext,
  ModToolStartEvent,
  ToolApprovalPolicy,
} from "@/mods/types";
import {
  permissionMode as globalPermissionMode,
  type PermissionMode,
} from "@/permissions/mode";
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
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { debugLog } from "@/utils/debug";
import { refreshAndListSecrets } from "@/utils/secrets-store";
import { isRecord } from "@/utils/type-guards";
import { toolFilter } from "./filter";
import {
  functionToolForm,
  type JsonSchema,
  type ModelFacingToolForm,
  serializeFunctionOnlyToolPayload,
} from "./model-facing-tool";
import {
  extractSecretEnvFromCommand,
  scrubSecretsFromString,
} from "./secret-substitution";
import { TOOL_DEFINITIONS, type ToolName } from "./tool-definitions";

export const TOOL_NAMES = Object.keys(TOOL_DEFINITIONS) as ToolName[];

/**
 * Append MessageChannel tool if any channels are active.
 * Used by both resolveBaseToolNamesForModel() and getToolNamesForToolset().
 */
function maybeAppendChannelTools(
  toolNames: ToolName[],
  channelToolScope?: MessageChannelToolDiscoveryScope | null,
): ToolName[] {
  const hasActiveChannelTools =
    channelToolScope !== undefined
      ? (channelToolScope?.channels.length ?? 0) > 0
      : getActiveChannelIds().length > 0;
  if (
    hasActiveChannelTools &&
    !toolNames.includes("MessageChannel" as ToolName)
  ) {
    return [...toolNames, "MessageChannel" as ToolName];
  }
  return toolNames;
}

/**
 * Inject dynamic channel-tool discovery into MessageChannel if channels are active.
 * Used by both buildRegistryForModel() and buildSpecificToolRegistry().
 */
async function maybeResolveDynamicChannelTool(
  name: string,
  description: string,
  schema: Record<string, unknown>,
  channelToolScope?: MessageChannelToolDiscoveryScope | null,
): Promise<{ description: string; input_schema: Record<string, unknown> }> {
  if (name !== "MessageChannel") {
    return {
      description,
      input_schema: schema,
    };
  }
  const resolved = await buildDynamicMessageChannelToolDefinition(
    description,
    schema,
    channelToolScope,
  );
  return {
    description: resolved.description,
    input_schema: resolved.schema,
  };
}

async function resolveBackendSpecificToolDescription(
  name: string,
  description: string,
): Promise<string> {
  let isLocalMemfs = false;
  try {
    const { getBackend } = await import("@/backend");
    isLocalMemfs = getBackend().capabilities.localMemfs;
  } catch {
    isLocalMemfs = false;
  }
  if (!isLocalMemfs) return description;

  if (name === "memory_apply_patch") {
    return description.replace(
      "The harness pushes clean committed memory changes after the turn for remote MemFS agents.",
      "Local backend MemFS has no Letta remote; memory changes are committed locally.",
    );
  }

  if (name === "memory") {
    return description.replace(
      "The harness pushes clean committed memory changes after the turn for remote MemFS agents.",
      "Local backend MemFS has no Letta remote; memory changes are committed locally.",
    );
  }

  return description;
}

function resolvedModelForm(
  base: ModelFacingToolForm,
  description: string,
  inputSchema: JsonSchema,
): ModelFacingToolForm {
  if (base.type === "custom") {
    return {
      ...base,
      functionFallback: {
        ...base.functionFallback,
        description,
        parameters: inputSchema,
      },
    };
  }

  return functionToolForm({
    description,
    parameters: inputSchema,
  });
}

function withDynamicMessageChannelCache(registry: ToolRegistry): ToolRegistry {
  const nextRegistry = new Map(registry);
  const existing = nextRegistry.get("MessageChannel");

  // Only update an existing entry — never inject MessageChannel into a registry
  // that deliberately excluded it (e.g. a conversation with no channel routes).
  if (!existing) {
    return nextRegistry;
  }

  if (
    existing.schema.description !== TOOL_DEFINITIONS.MessageChannel.description
  ) {
    return nextRegistry;
  }

  if (getActiveChannelIds().length === 0) {
    nextRegistry.delete("MessageChannel");
    return nextRegistry;
  }

  const cachedMessageChannel = getCachedDynamicMessageChannelToolDefinition();
  if (!cachedMessageChannel) {
    return nextRegistry;
  }

  nextRegistry.set("MessageChannel", {
    schema: {
      name: "MessageChannel",
      description: cachedMessageChannel.description,
      input_schema: cachedMessageChannel.schema as JsonSchema,
    },
    modelForm: functionToolForm({
      description: cachedMessageChannel.description,
      parameters: cachedMessageChannel.schema as JsonSchema,
    }),
    fn: existing?.fn ?? TOOL_DEFINITIONS.MessageChannel.impl,
  });
  return nextRegistry;
}
const STREAMING_SHELL_TOOLS = new Set([
  "Bash",
  "BashOutput",
  "TaskOutput",
  "exec_command",
  "write_stdin",
  "shell_command",
  "ShellCommand",
  "shell",
  "Shell",
  "run_shell_command",
  "RunShellCommand",
]);

// Tools that write files — used to trigger onFileWrite broadcast after execution.
const FILE_MUTATING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "replace"]);

// Maps internal tool names to server/model-facing tool names
// This allows us to have multiple implementations (e.g., write_file_gemini, Write from Anthropic)
// that map to the same server tool name since only one toolset is active at a time
const TOOL_NAME_MAPPINGS: Partial<Record<ToolName, string>> = {
  // Gemini tools - map to their original Gemini CLI names
  glob_gemini: "glob",
  write_todos: "write_todos",
  write_file_gemini: "write_file",
  replace: "replace",
  search_file_content: "search_file_content",
  read_many_files: "read_many_files",
  read_file_gemini: "read_file",
  list_directory: "list_directory",
  run_shell_command: "run_shell_command",
  // Align subagent-spawning tool with Claude Code: surface internal `Task` as `Agent`.
  // Internal implementation name stays `Task` for backward compat with existing
  // agent states; getInternalToolName("Agent") resolves back to "Task".
  Task: "Agent",
};

/**
 * Get the server-facing name for a tool (maps internal names to what the model sees)
 */
export function getServerToolName(internalName: string): string {
  return TOOL_NAME_MAPPINGS[internalName as ToolName] || internalName;
}

/**
 * Get the internal tool name from a server-facing name
 * Used when the server sends back tool calls/approvals with server names
 */
export function getInternalToolName(serverName: string): string {
  // Build reverse mapping
  for (const [internal, server] of Object.entries(TOOL_NAME_MAPPINGS)) {
    if (server === serverName) {
      return internal;
    }
  }
  // If not in mapping, the server name is the internal name
  return serverName;
}

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

export function filterBuiltInToolNamesByClientAllowlist(
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

const WORKTREE_TOOL_NAMES = new Set<ToolName>(["EnterWorktree"]);
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

function filterExternalToolsByRuntimeContext(
  externalTools: Map<string, ExternalToolDefinition>,
  runtimeContext: RuntimeContextSnapshot,
): Map<string, ExternalToolDefinition> {
  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      if (!tool.runtime) {
        return true;
      }
      return (
        tool.runtime.agentId === runtimeContext.agentId &&
        tool.runtime.conversationId === runtimeContext.conversationId
      );
    }),
  );
}

function filterExternalToolsByScopeIds(
  externalTools: Map<string, ExternalToolDefinition>,
  externalToolScopeIds?: string[],
): Map<string, ExternalToolDefinition> {
  const selectedScopes = new Set(externalToolScopeIds ?? []);
  return new Map(
    Array.from(externalTools.entries()).filter(([, tool]) => {
      if (tool.scopeId === undefined) {
        return true;
      }
      return selectedScopes.has(tool.scopeId);
    }),
  );
}

function toModelFacingExternalToolMap(
  externalTools: Map<string, ExternalToolDefinition>,
): Map<string, ExternalToolDefinition> {
  const modelFacingTools = new Map<string, ExternalToolDefinition>();
  for (const tool of externalTools.values()) {
    // MVP: if one runtime exposes duplicate model-facing names, the later
    // registration wins. We keep cross-runtime registrations isolated by using
    // namespaced internal keys before this final model-facing collapse.
    modelFacingTools.set(tool.name, tool);
  }
  return modelFacingTools;
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

export const ANTHROPIC_DEFAULT_TOOLS: ToolName[] = [
  "AskUserQuestion",
  "Bash",
  "TaskOutput",
  "EnterWorktree",
  "Edit",
  "TaskStop",
  // "MultiEdit",
  // "LS",
  "memory",
  "Read",
  "Skill",
  "Task",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskUpdate",
  "Write",
];

export const OPENAI_DEFAULT_TOOLS: ToolName[] = [
  "exec_command",
  "write_stdin",
  // TODO(codex-parity): add once request_user_input tool exists in raw codex path.
  // "request_user_input",
  "apply_patch",
  "memory_apply_patch",
  "update_plan",
  "view_image",
];

export const GEMINI_DEFAULT_TOOLS: ToolName[] = [
  "run_shell_command",
  "read_file_gemini",
  "list_directory",
  "glob_gemini",
  "search_file_content",
  "memory",
  "EnterWorktree",
  "replace",
  "write_file_gemini",
  "write_todos",
  "read_many_files",
  "Skill",
  "Task",
];

// PascalCase toolsets (codex-2 and gemini-2) for consistency with Skill tool naming
export const OPENAI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterWorktree",
  "memory_apply_patch",
  "Task",
  "TaskOutput",
  "TaskStop",
  "Skill",
  // Standard Codex tools
  "exec_command",
  "write_stdin",
  "ViewImage",
  "ApplyPatch",
  "UpdatePlan",
];

export const GEMINI_PASCAL_TOOLS: ToolName[] = [
  // Additional Letta Code tools
  "AskUserQuestion",
  "EnterWorktree",
  "memory",
  "Skill",
  "Task",
  // Standard Gemini tools
  "RunShellCommand",
  "ReadFileGemini",
  "ListDirectory",
  "GlobGemini",
  "SearchFileContent",
  "Replace",
  "WriteFileGemini",
  "WriteTodos",
  "ReadManyFiles",
];

// Tool permissions configuration
const TOOL_PERMISSIONS: Record<
  ToolName,
  { requiresApproval: boolean; approvalPolicy?: ToolApprovalPolicy }
> = {
  AskUserQuestion: { requiresApproval: true },
  Bash: { requiresApproval: true },
  BashOutput: { requiresApproval: false },
  TaskOutput: { requiresApproval: false },
  EnterWorktree: { requiresApproval: true },
  Edit: { requiresApproval: true },
  Glob: { requiresApproval: false },
  Grep: { requiresApproval: false },
  KillBash: { requiresApproval: true },
  TaskStop: { requiresApproval: true },
  LS: { requiresApproval: false },
  memory: { requiresApproval: false },
  memory_apply_patch: { requiresApproval: false },
  MessageChannel: { requiresApproval: false },
  MultiEdit: { requiresApproval: true },
  Read: { requiresApproval: false },
  read_artifact_file: { requiresApproval: false },
  view_image: { requiresApproval: false },
  ViewImage: { requiresApproval: false },
  ReadLSP: { requiresApproval: false },
  Skill: { requiresApproval: false },
  Task: { requiresApproval: true },
  TaskCreate: { requiresApproval: false },
  TaskGet: { requiresApproval: false },
  TaskList: { requiresApproval: false },
  TaskUpdate: { requiresApproval: false },
  TodoWrite: { requiresApproval: false },
  Write: { requiresApproval: true },
  write_artifact_file: { requiresApproval: false },
  shell_command: { requiresApproval: true },
  exec_command: { requiresApproval: true },
  write_stdin: { requiresApproval: false },
  shell: { requiresApproval: true },
  read_file: { requiresApproval: false },
  list_dir: { requiresApproval: false },
  grep_files: { requiresApproval: false },
  apply_patch: { requiresApproval: true },
  update_plan: { requiresApproval: false },
  // Gemini toolset
  glob_gemini: { requiresApproval: false },
  list_directory: { requiresApproval: false },
  read_file_gemini: { requiresApproval: false },
  read_many_files: { requiresApproval: false },
  replace: { requiresApproval: true },
  run_shell_command: { requiresApproval: true },
  search_file_content: { requiresApproval: false },
  write_todos: { requiresApproval: false },
  write_file_gemini: { requiresApproval: true },
  // Codex-2 toolset (PascalCase)
  ShellCommand: { requiresApproval: true },
  Shell: { requiresApproval: true },
  ReadFile: { requiresApproval: false },
  ListDir: { requiresApproval: false },
  GrepFiles: { requiresApproval: false },
  ApplyPatch: { requiresApproval: true },
  UpdatePlan: { requiresApproval: false },
  // Gemini-2 toolset (PascalCase)
  RunShellCommand: { requiresApproval: true },
  ReadFileGemini: { requiresApproval: false },
  ListDirectory: { requiresApproval: false },
  GlobGemini: { requiresApproval: false },
  SearchFileContent: { requiresApproval: false },
  Replace: { requiresApproval: true },
  WriteFileGemini: { requiresApproval: true },
  WriteTodos: { requiresApproval: false },
  ReadManyFiles: { requiresApproval: false },
};

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

// Tool return content can be a string or array of text/image content parts
export type ToolReturnContent = string | Array<TextContent | ImageContent>;

export type ToolExecutionResult = {
  toolReturn: ToolReturnContent;
  status: "success" | "error";
  stdout?: string[];
  stderr?: string[];
};

type ToolRegistry = Map<string, ToolDefinition>;

// Use globalThis to ensure singleton across bundle duplicates
// This prevents Bun's bundler from creating duplicate instances
const REGISTRY_KEY = Symbol.for("@letta/toolRegistry");
const SWITCH_LOCK_KEY = Symbol.for("@letta/toolSwitchLock");
const EXECUTION_CONTEXTS_KEY = Symbol.for("@letta/toolExecutionContexts");

interface SwitchLockState {
  promise: Promise<void> | null;
  resolve: (() => void) | null;
  refCount: number; // Ref-counted to handle overlapping switches
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
let toolExecutionContextCounter = 0;

/**
 * Mutable, shared-by-reference permission mode state.
 * Listener mode populates this from ConversationRuntime; CLI mode uses a
 * wrapper around the global permissionMode singleton.
 */
export type PermissionModeState = {
  mode: PermissionMode;
};

type ToolExecutionContextSnapshot = {
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

  // Keep memory bounded; stale turns won't need old snapshots.
  const MAX_CONTEXTS = 4096;
  if (contexts.size > MAX_CONTEXTS) {
    const oldestContextId = contexts.keys().next().value;
    if (oldestContextId) {
      contexts.delete(oldestContextId);
    }
  }

  return contextId;
}

function buildExecutionRuntimeContextSnapshot(options?: {
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  runtimeContext?: Partial<RuntimeContextSnapshot>;
  channelToolScope?: MessageChannelToolDiscoveryScope | null;
  channelTurnSources?: ChannelTurnSource[];
}): RuntimeContextSnapshot {
  const mergedScope: RuntimeContextSnapshot = {
    ...(getRuntimeContext() ?? {}),
    ...(options?.runtimeContext ?? {}),
  };

  if (mergedScope.agentId === undefined) {
    try {
      mergedScope.agentId = getCurrentAgentId();
    } catch {
      // Leave unset when no scoped or global agent context exists.
    }
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

/**
 * Returns the mutable PermissionModeState for an execution context.
 */
export function getExecutionContextPermissionModeState(
  contextId: string,
): PermissionModeState | undefined {
  return getExecutionContextById(contextId)?.permissionModeState;
}

export function clearCapturedToolExecutionContexts(): void {
  getExecutionContexts().clear();
}

export function releaseToolExecutionContext(contextId: string): void {
  getExecutionContexts().delete(contextId);
}

/**
 * Acquires the toolset switch lock. Call before starting async tool loading.
 * Ref-counted: multiple overlapping switches will keep the lock held until all complete.
 * Any calls to waitForToolsetReady() will block until all switches finish.
 */
function acquireSwitchLock(): void {
  const lock = getSwitchLock();
  lock.refCount++;

  // Only create a new promise if this is the first acquirer
  if (lock.refCount === 1) {
    lock.promise = new Promise((resolve) => {
      lock.resolve = resolve;
    });
  }
}

/**
 * Releases the toolset switch lock. Call after atomic registry swap completes.
 * Only actually releases when all acquirers have released (ref-count drops to 0).
 */
function releaseSwitchLock(): void {
  const lock = getSwitchLock();

  if (lock.refCount > 0) {
    lock.refCount--;
  }

  // Only resolve when all switches are done
  if (lock.refCount === 0 && lock.resolve) {
    lock.resolve();
    lock.promise = null;
    lock.resolve = null;
  }
}

/**
 * Waits for any in-progress toolset switch to complete.
 * Call this before reading from the registry to ensure you get the final toolset.
 * Returns immediately if no switch is in progress.
 */
export async function waitForToolsetReady(): Promise<void> {
  const lock = getSwitchLock();
  if (lock.promise) {
    await lock.promise;
  }
}

/**
 * Checks if a toolset switch is currently in progress.
 * Useful for synchronous checks where awaiting isn't possible.
 */
export function isToolsetSwitchInProgress(): boolean {
  return getSwitchLock().refCount > 0;
}

/**
 * Resolve a server/visible tool name to an internal tool name
 * based on the currently loaded toolset.
 *
 * - If a tool with the exact name is loaded, prefer that.
 * - Otherwise, fall back to the alias mapping used for Gemini tools.
 * - Returns undefined if no matching tool is loaded.
 */
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

/**
 * ClientTool interface matching the Letta SDK's expected format.
 * Used when passing client-side tools via the client_tools field.
 */
export interface ClientTool {
  name: string;
  description?: string | null;
  parameters?: { [key: string]: unknown } | null;
}

// ═══════════════════════════════════════════════════════════════
// EXTERNAL TOOLS (SDK-side execution)
// ═══════════════════════════════════════════════════════════════

/**
 * External tool definition from SDK
 */
export interface ExternalToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  /** Internal registration key; model-facing calls still use name. */
  registrationKey?: string;
  /** Optional visibility scope; scoped tools are hidden unless selected for a turn. */
  scopeId?: string;
  /** Optional runtime owner; runtime-owned tools are visible only in that runtime. */
  runtime?: {
    agentId?: string;
    conversationId?: string;
  };
}

/**
 * Callback to execute an external tool via SDK
 */
export type ExternalToolExecutor = (
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  context?: { tool: ExternalToolDefinition },
) => Promise<{
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError: boolean;
}>;

// Storage for external tool definitions and executor
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

/**
 * Register external tools from SDK
 */
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

/**
 * Set the executor callback for external tools
 */
export function setExternalToolExecutor(executor: ExternalToolExecutor): void {
  (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY] = executor;
}

function getExternalToolExecutor(): ExternalToolExecutor | undefined {
  return (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY];
}

/**
 * Clear external tools (for testing or session cleanup)
 */
export function clearExternalTools(): void {
  getExternalToolsRegistry().clear();
  delete (globalThis as GlobalWithExternalTools)[EXTERNAL_EXECUTOR_KEY];
}

/**
 * Check if a tool is external (SDK-executed)
 */
export function isExternalTool(name: string): boolean {
  return getExternalToolsRegistry().has(name);
}

/**
 * Get external tool definition
 */
export function getExternalToolDefinition(
  name: string,
): ExternalToolDefinition | undefined {
  return getExternalToolsRegistry().get(name);
}

/**
 * Get all external tools as ClientTool format
 */
export function getExternalToolsAsClientTools(): ClientTool[] {
  return Array.from(
    toModelFacingExternalToolMap(
      filterExternalToolsByRuntimeContext(getExternalToolsRegistry(), {}),
    ).values(),
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * Execute an external tool via SDK
 */
export async function executeExternalTool(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown>,
  executorOverride?: ExternalToolExecutor,
  toolDefinition?: ExternalToolDefinition,
): Promise<ToolExecutionResult> {
  const executor = executorOverride ?? getExternalToolExecutor();
  if (!executor) {
    return {
      toolReturn: `External tool executor not set for tool: ${toolName}`,
      status: "error",
    };
  }

  try {
    const tool = toolDefinition ?? getExternalToolDefinition(toolName);
    const result = await executor(
      toolCallId,
      toolName,
      input,
      tool ? { tool } : undefined,
    );

    // Convert external tool result to ToolExecutionResult format
    const textContent = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    return {
      toolReturn: textContent || JSON.stringify(result.content),
      status: result.isError ? "error" : "success",
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      toolReturn: `External tool execution error: ${errorMessage}`,
      status: "error",
    };
  }
}

/**
 * Get all loaded tools in the format expected by the Letta API's client_tools field.
 * Maps internal tool names to server-facing names for proper tool invocation.
 * Includes built-in, external, and mod tools.
 */
export function getClientToolsFromRegistry(): ClientTool[] {
  return buildClientToolsFromSnapshot(
    withDynamicMessageChannelCache(toolRegistry),
    toModelFacingExternalToolMap(
      filterExternalToolsByRuntimeContext(getExternalToolsRegistry(), {}),
    ),
    getAvailableModToolsRegistry(),
  );
}

function buildClientToolsFromSnapshot(
  registry: ToolRegistry,
  externalTools: Map<string, ExternalToolDefinition>,
  modTools: Map<string, ModToolDefinition>,
): ClientTool[] {
  const builtInTools = Array.from(registry.entries()).map(([name, tool]) =>
    serializeFunctionOnlyToolPayload(getServerToolName(name), tool.modelForm),
  );
  for (const name of externalTools.keys()) {
    if (modTools.has(name)) {
      debugLog(
        "tools",
        "mod tool %s shadows external tool with same name",
        name,
      );
    }
  }
  const externalClientTools = Array.from(externalTools.values())
    .filter((tool) => !modTools.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  const modClientTools = Array.from(modTools.values()).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return [...builtInTools, ...externalClientTools, ...modClientTools];
}

function getEffectivePermissionModeState(
  permissionModeState?: PermissionModeState,
): PermissionModeState {
  // When no scoped state is provided (local/CLI mode), create a live proxy to
  // the global singleton.
  return (
    permissionModeState ?? {
      get mode() {
        return globalPermissionMode.getMode();
      },
      set mode(value: PermissionMode) {
        globalPermissionMode.setMode(value);
      },
    }
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
    externalToolScopeIds?: string[];
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    modContext?: ModContext;
    modEvents?: ModEvents;
    runtimeContext?: Partial<RuntimeContextSnapshot>;
    channelToolScope?: MessageChannelToolDiscoveryScope | null;
    channelTurnSources?: ChannelTurnSource[];
  },
): PreparedToolExecutionContext {
  const runtimeContext = buildExecutionRuntimeContextSnapshot(options);
  const clientToolAllowlist =
    options?.clientToolAllowlist ?? toolFilter.getEnabledTools() ?? undefined;
  if (options?.channelToolScope !== undefined) {
    runtimeContext.channelToolScope = options.channelToolScope;
  }
  if (options?.channelTurnSources?.length) {
    runtimeContext.channelTurnSources = [...options.channelTurnSources];
  }
  const toolRegistrySnapshot = filterToolRegistryByClientAllowlist(
    withDynamicMessageChannelCache(snapshot.toolRegistry),
    clientToolAllowlist,
  );
  const executionSnapshot: ToolExecutionContextSnapshot = {
    toolRegistry: toolRegistrySnapshot,
    externalTools: toModelFacingExternalToolMap(
      filterExternalToolsByClientAllowlist(
        filterExternalToolsByScopeIds(
          filterExternalToolsByRuntimeContext(
            snapshot.externalTools,
            runtimeContext,
          ),
          options?.externalToolScopeIds,
        ),
        clientToolAllowlist,
      ),
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
  const contextId = saveExecutionContext(executionSnapshot);
  executionSnapshot.runtimeContext.toolContextId = contextId;

  return {
    contextId,
    clientTools: buildClientToolsFromSnapshot(
      executionSnapshot.toolRegistry,
      executionSnapshot.externalTools,
      executionSnapshot.modTools,
    ),
    loadedToolNames: buildClientToolsFromSnapshot(
      executionSnapshot.toolRegistry,
      new Map(),
      executionSnapshot.modTools,
    ).map((tool) => tool.name),
  };
}

/**
 * Capture a turn-scoped tool snapshot and corresponding client_tools payload.
 * The returned context id can be used later to execute tool calls against this
 * exact snapshot even if the global registry changes between dispatch and execute.
 */
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
    },
  );
}

export async function prepareCurrentToolExecutionContext(options?: {
  workingDirectory?: string;
  permissionModeState?: PermissionModeState;
  runtimeContext?: Partial<RuntimeContextSnapshot>;
  channelToolScope?: MessageChannelToolDiscoveryScope | null;
  channelTurnSources?: ChannelTurnSource[];
  modContext?: ModContext;
  modEvents?: ModEvents;
}): Promise<PreparedToolExecutionContext> {
  await waitForToolsetReady();
  const currentToolNames = maybeAppendChannelTools(
    Array.from(toolRegistry.keys()) as ToolName[],
  );
  const toolRegistrySnapshot =
    await buildSpecificToolRegistry(currentToolNames);
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: toolRegistrySnapshot,
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext: options?.modContext,
      modEvents: options?.modEvents,
      modPermissions: getAvailableModPermissionsRegistry(options?.modContext),
      modTools: getAvailableModToolsRegistry(options?.modContext),
    },
    options,
  );
}

export async function prepareToolExecutionContextForSpecificTools(
  toolNames: string[],
  options?: {
    clientToolAllowlist?: string[];
    externalToolScopeIds?: string[];
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    channelToolScope?: MessageChannelToolDiscoveryScope | null;
    channelTurnSources?: ChannelTurnSource[];
    modContext?: ModContext;
    modEvents?: ModEvents;
    runtimeContext?: Partial<RuntimeContextSnapshot>;
  },
): Promise<PreparedToolExecutionContext> {
  const toolRegistrySnapshot = await buildSpecificToolRegistry(
    toolNames,
    options?.channelToolScope,
  );
  return capturePreparedToolExecutionContext(
    {
      toolRegistry: toolRegistrySnapshot,
      externalTools: new Map(getExternalToolsRegistry()),
      externalExecutor: getExternalToolExecutor(),
      modContext: options?.modContext,
      modEvents: options?.modEvents,
      modPermissions: getAvailableModPermissionsRegistry(options?.modContext),
      modTools: getAvailableModToolsRegistry(options?.modContext),
    },
    options,
  );
}

export async function prepareToolExecutionContextForModel(
  modelIdentifier?: string,
  options?: {
    exclude?: ToolName[];
    include?: ToolName[];
    clientToolAllowlist?: string[];
    externalToolScopeIds?: string[];
    workingDirectory?: string;
    permissionModeState?: PermissionModeState;
    channelToolScope?: MessageChannelToolDiscoveryScope | null;
    channelTurnSources?: ChannelTurnSource[];
    modContext?: ModContext;
    modEvents?: ModEvents;
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
      modPermissions: getAvailableModPermissionsRegistry(options?.modContext),
      modTools: getAvailableModToolsRegistry(options?.modContext),
    },
    options,
  );
}

/**
 * Get permissions for a specific tool.
 * @param toolName - The name of the tool
 * @returns Tool permissions object with requiresApproval flag
 */
export function getToolPermissions(toolName: string) {
  const approvalPolicy = getToolApprovalPolicy(toolName);
  return { requiresApproval: approvalPolicy !== "auto", approvalPolicy };
}

export function getToolApprovalPolicy(
  toolName: string,
  contextId?: string | null,
): ToolApprovalPolicy {
  const context = contextId ? getExecutionContextById(contextId) : undefined;
  const modPolicy = modToolApprovalPolicy(
    toolName,
    context?.modTools ?? getAvailableModToolsRegistry(),
  );
  if (modPolicy) return modPolicy;

  const toolPermission = TOOL_PERMISSIONS[toolName as ToolName];
  if (!toolPermission) return "auto";
  if (toolPermission.approvalPolicy) return toolPermission.approvalPolicy;
  return toolPermission.requiresApproval ? "ask" : "auto";
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

/**
 * Check permission for a tool execution using the full permission system.
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory (defaults to process.cwd())
 * @returns Permission decision: "allow", "deny", "ask", or "alwaysAsk"
 */
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

/**
 * Save a permission rule to settings
 * @param rule - Permission rule (e.g., "Read(src/**)")
 * @param ruleType - Type of rule ("allow", "deny", "ask", or "alwaysAsk")
 * @param scope - Where to save ("project", "local", "user", or "session")
 * @param workingDirectory - Current working directory
 */
export async function savePermissionRule(
  rule: string,
  ruleType: PermissionRuleType,
  scope: "project" | "local" | "user" | "session",
  workingDirectory: string = process.cwd(),
): Promise<void> {
  // Handle session-only permissions
  if (scope === "session") {
    const { sessionPermissions } = await import("@/permissions/session");
    sessionPermissions.addRule(rule, ruleType);
    return;
  }

  // Handle persisted permissions
  const { savePermissionRule: save } = await import("@/permissions/loader");
  await save(rule, ruleType, scope, workingDirectory);
}

/**
 * Analyze approval context for a tool execution
 * @param toolName - Name of the tool
 * @param toolArgs - Tool arguments
 * @param workingDirectory - Current working directory
 * @returns Approval context with recommended rule and button text
 */
export async function analyzeToolApproval(
  toolName: string,
  toolArgs: ToolArgs,
  workingDirectory: string = process.cwd(),
): Promise<import("@/permissions/analyzer").ApprovalContext> {
  const { analyzeApprovalContext } = await import("@/permissions/analyzer");
  return analyzeApprovalContext(toolName, toolArgs, workingDirectory);
}

/**
 * Atomically replaces the tool registry contents.
 * This ensures no intermediate state where registry is empty or partial.
 *
 * @param newTools - Map of tools to replace the registry with
 */
function replaceRegistry(newTools: ToolRegistry): void {
  // Single sync block - no awaits, no yields, no interleaving possible
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

async function buildSpecificToolRegistry(
  toolNames: string[],
  channelToolScope?: MessageChannelToolDiscoveryScope | null,
): Promise<ToolRegistry> {
  const { toolFilter } = await import("@/tools/filter");
  const newRegistry: ToolRegistry = new Map();

  for (const name of toolNames) {
    if (!toolFilter.isEnabled(name)) {
      continue;
    }

    const internalName = getInternalToolName(name);
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

    const description = await resolveBackendSpecificToolDescription(
      internalName,
      definition.description,
    );

    const resolvedTool = await maybeResolveDynamicChannelTool(
      internalName,
      description,
      definition.schema,
      channelToolScope,
    );

    const toolSchema: ToolSchema = {
      name: internalName,
      description: resolvedTool.description,
      input_schema: resolvedTool.input_schema as JsonSchema,
    };

    newRegistry.set(internalName, {
      schema: toolSchema,
      modelForm: resolvedModelForm(
        definition.modelForm,
        resolvedTool.description,
        resolvedTool.input_schema as JsonSchema,
      ),
      fn: definition.impl,
    });
  }

  maybeApplyLspReadOverride(newRegistry);
  return newRegistry;
}

async function resolveBaseToolNamesForModel(
  modelIdentifier?: string,
  options?: {
    exclude?: ToolName[];
    include?: ToolName[];
    clientToolAllowlist?: string[];
    channelToolScope?: MessageChannelToolDiscoveryScope | null;
  },
): Promise<ToolName[]> {
  const { toolFilter } = await import("@/tools/filter");
  let baseToolNames: ToolName[];
  if (
    !toolFilter.isActive() &&
    modelIdentifier &&
    isOpenAIModel(modelIdentifier)
  ) {
    baseToolNames = OPENAI_PASCAL_TOOLS;
  } else if (!toolFilter.isActive()) {
    // Temporary rollback: Gemini models should use the default Claude-style
    // toolset until we intentionally restore the Gemini-specific toolset.
    baseToolNames = ANTHROPIC_DEFAULT_TOOLS;
  } else {
    baseToolNames = TOOL_NAMES;
  }

  if (options?.exclude && options.exclude.length > 0) {
    const excludeSet = new Set(options.exclude);
    baseToolNames = baseToolNames.filter((name) => !excludeSet.has(name));
  }

  if (options?.include && options.include.length > 0) {
    const seen = new Set(baseToolNames);
    for (const name of options.include) {
      if (!seen.has(name)) {
        baseToolNames.push(name);
        seen.add(name);
      }
    }
  }

  baseToolNames = filterWorktreeTools(baseToolNames);

  baseToolNames = resolveArtifactToolNames(baseToolNames);

  // Append channel tool if channels are active
  baseToolNames = maybeAppendChannelTools(
    baseToolNames,
    options?.channelToolScope,
  );

  baseToolNames = filterBuiltInToolNamesByClientAllowlist(
    baseToolNames,
    options?.clientToolAllowlist,
  );

  return baseToolNames;
}

async function buildRegistryForModel(
  modelIdentifier?: string,
  options?: {
    exclude?: ToolName[];
    include?: ToolName[];
    clientToolAllowlist?: string[];
    channelToolScope?: MessageChannelToolDiscoveryScope | null;
  },
): Promise<ToolRegistry> {
  const { toolFilter } = await import("@/tools/filter");
  const allSubagentConfigs = await getAllSubagentConfigs();
  const discoveredSubagents = Object.entries(allSubagentConfigs).map(
    ([name, config]) => ({
      name,
      description: config.description,
      recommendedModel: config.recommendedModel,
    }),
  );
  const baseToolNames = await resolveBaseToolNamesForModel(
    modelIdentifier,
    options,
  );
  const newRegistry: ToolRegistry = new Map();

  for (const name of baseToolNames) {
    if (!toolFilter.isEnabled(name)) {
      continue;
    }

    try {
      const definition = TOOL_DEFINITIONS[name];
      if (!definition) {
        throw new Error(`Missing tool definition for ${name}`);
      }

      if (!definition.impl) {
        throw new Error(`Tool implementation not found for ${name}`);
      }

      let description = await resolveBackendSpecificToolDescription(
        name,
        definition.description,
      );
      if (name === "Task" && discoveredSubagents.length > 0) {
        description = injectSubagentsIntoTaskDescription(
          description,
          discoveredSubagents,
        );
      }

      const resolvedTool = await maybeResolveDynamicChannelTool(
        name,
        description,
        definition.schema,
        options?.channelToolScope,
      );

      const toolSchema: ToolSchema = {
        name,
        description: resolvedTool.description,
        input_schema: resolvedTool.input_schema as JsonSchema,
      };

      newRegistry.set(name, {
        schema: toolSchema,
        modelForm: resolvedModelForm(
          definition.modelForm,
          resolvedTool.description,
          resolvedTool.input_schema as JsonSchema,
        ),
        fn: definition.impl,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : JSON.stringify(error);
      throw new Error(
        `Required tool "${name}" could not be loaded from bundled assets. ${message}`,
      );
    }
  }

  maybeApplyLspReadOverride(newRegistry);
  return newRegistry;
}

/**
 * Loads specific tools by name into the registry.
 * Used when resuming an agent to load only the tools attached to that agent.
 *
 * Acquires the toolset switch lock during loading to prevent message sends from
 * reading stale tools. Callers should use waitForToolsetReady() before sending messages.
 *
 * @param toolNames - Array of specific tool names to load
 */
export async function loadSpecificTools(toolNames: string[]): Promise<void> {
  // Acquire lock to signal that a switch is in progress
  acquireSwitchLock();

  try {
    const newRegistry = await buildSpecificToolRegistry(toolNames);
    replaceRegistry(newRegistry);
  } finally {
    // Always release the lock, even if an error occurred
    releaseSwitchLock();
  }
}

/**
 * Loads all tools defined in TOOL_NAMES and constructs their full schemas + function references.
 * This should be called on program startup.
 * Will error if any expected tool files are missing.
 *
 * Acquires the toolset switch lock during loading to prevent message sends from
 * reading stale tools. Callers should use waitForToolsetReady() before sending messages.
 *
 * @param modelIdentifier - Optional model identifier to select the appropriate toolset
 * @param options - Optional configuration
 * @param options.exclude - Tool names to exclude from the loaded toolset
 * @returns Promise that resolves when all tools are loaded
 */
export async function loadTools(
  modelIdentifier?: string,
  options?: { exclude?: ToolName[] },
): Promise<void> {
  // Acquire lock to signal that a switch is in progress
  acquireSwitchLock();

  try {
    const newRegistry = await buildRegistryForModel(modelIdentifier, options);
    replaceRegistry(newRegistry);
  } finally {
    // Always release the lock, even if an error occurred
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
  // Fallback: treat raw handle-style identifiers as OpenAI for openai/*
  // and ChatGPT OAuth Codex provider handles.
  return (
    modelIdentifier.startsWith("openai/") ||
    modelIdentifier.startsWith("openai-codex/") ||
    modelIdentifier.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`) ||
    modelIdentifier.startsWith("chatgpt_oauth/")
  );
}

export function isGeminiModel(modelIdentifier: string): boolean {
  const info = getModelInfo(modelIdentifier);
  if (info?.handle && typeof info.handle === "string") {
    return (
      info.handle.startsWith("google/") || info.handle.startsWith("google_ai/")
    );
  }
  // Fallback: treat raw handle-style identifiers as Gemini
  return (
    modelIdentifier.startsWith("google/") ||
    modelIdentifier.startsWith("google_ai/")
  );
}

/**
 * Inject discovered subagent descriptions into the Task tool description
 */
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

  // Build subagents section
  const agentsSection = subagents
    .map((agent) => {
      return `### ${agent.name}
- **Purpose**: ${agent.description}
- **Recommended model**: ${agent.recommendedModel}`;
    })
    .join("\n\n");

  // Insert before ## Usage section
  const usageMarker = "## Usage";
  const usageIndex = baseDescription.indexOf(usageMarker);

  if (usageIndex === -1) {
    // Fallback: append at the end
    return `${baseDescription}\n\n## Available Agents\n\n${agentsSection}`;
  }

  // Insert agents section before ## Usage
  const before = baseDescription.slice(0, usageIndex);
  const after = baseDescription.slice(usageIndex);

  return `${before}## Available Agents\n\n${agentsSection}\n\n${after}`;
}

/**
 * Helper to clip tool return text to a reasonable display size
 * Used by UI components to truncate long responses for display
 */
export function clipToolReturn(
  text: string,
  maxLines: number = 3,
  maxChars: number = 300,
): string {
  if (!text) return text;

  // Don't clip user rejection reasons - they contain important feedback
  // All denials use format: "Error: request to call tool denied. User reason: ..."
  if (text.includes("request to call tool denied")) {
    return text;
  }

  // First apply character limit to avoid extremely long text
  let clipped = text;
  if (text.length > maxChars) {
    clipped = text.slice(0, maxChars);
  }

  // Then split into lines and limit line count
  const lines = clipped.split("\n");
  if (lines.length > maxLines) {
    clipped = lines.slice(0, maxLines).join("\n");
  }

  // Add ellipsis if we truncated
  if (text.length > maxChars || lines.length > maxLines) {
    // Try to break at a word boundary if possible
    const lastSpace = clipped.lastIndexOf(" ");
    if (lastSpace > maxChars * 0.8) {
      clipped = clipped.slice(0, lastSpace);
    }
    clipped += "…";
  }

  return clipped;
}

/**
 * Flattens a tool response to a simple string format.
 * Extracts the actual content from structured responses to match what the LLM expects.
 *
 * @param result - The raw result from a tool execution
 * @returns A flattened string representation of the result
 */
function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

/**
 * Check if an array contains multimodal content (text + images)
 */
function isMultimodalContent(
  arr: unknown[],
): arr is Array<TextContent | ImageContent> {
  return arr.every(
    (item) => isRecord(item) && (item.type === "text" || item.type === "image"),
  );
}

const MOD_SECRET_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

type InvocationSecretRedactions = Map<string, string>;

function normalizeModSecretName(name: string): string {
  const normalized = name.toUpperCase();
  if (!MOD_SECRET_NAME_PATTERN.test(normalized)) {
    throw new Error(
      `Invalid secret name '${name}'. Use uppercase letters, numbers, and underscores only. Must start with a letter or underscore.`,
    );
  }
  return normalized;
}

function scrubInvocationSecretRedactions(
  input: string,
  redactions: InvocationSecretRedactions,
): string {
  let result = input;
  const entries = Array.from(redactions.entries()).sort(
    ([, a], [, b]) => b.length - a.length,
  );
  for (const [name, value] of entries) {
    if (value.length > 0) {
      result = result.replaceAll(value, `${name}=<REDACTED>`);
    }
  }
  return result;
}

function scrubModToolString(
  input: string,
  agentId: string | undefined,
  redactions: InvocationSecretRedactions,
): string {
  return scrubInvocationSecretRedactions(
    scrubSecretsFromString(input, agentId),
    redactions,
  );
}

function scrubModToolReturnContent(
  content: ToolReturnContent,
  agentId: string | undefined,
  redactions: InvocationSecretRedactions,
): ToolReturnContent {
  if (typeof content === "string") {
    return scrubModToolString(content, agentId, redactions);
  }
  return content.map((block) =>
    block.type === "text"
      ? { ...block, text: scrubModToolString(block.text, agentId, redactions) }
      : block,
  );
}

function scrubModToolLines(
  lines: string[] | undefined,
  agentId: string | undefined,
  redactions: InvocationSecretRedactions,
): string[] | undefined {
  return lines?.map((line) => scrubModToolString(line, agentId, redactions));
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
    // If there are other fields besides 'message', return the full object as JSON

    const keys = Object.keys(result);
    if (keys.length > 1) {
      return JSON.stringify(result);
    }
    return result.message;
  }

  // Check for multimodal content (images) - return as-is without flattening
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

type ToolHookContext = {
  args: Record<string, unknown>;
  debugLabel: string;
  scopedAgentId?: string;
  toolCallId?: string;
  toolName: string;
  workingDirectory: string;
};

async function collectPostToolHookFeedback(
  context: ToolHookContext,
  result: {
    errorType?: string;
    failureOutput?: string;
    output: string;
    status: "success" | "error";
  },
): Promise<string[]> {
  let postToolUseFeedback: string[] = [];
  try {
    const postHookResult = await runPostToolUseHooks(
      context.toolName,
      context.args,
      { status: result.status, output: result.output },
      context.toolCallId,
      context.workingDirectory,
      context.scopedAgentId,
      undefined,
      undefined,
    );
    postToolUseFeedback = postHookResult.feedback;
  } catch (error) {
    debugLog("hooks", `PostToolUse hook error (${context.debugLabel})`, error);
  }

  let postToolUseFailureFeedback: string[] = [];
  if (result.status === "error") {
    try {
      const failureHookResult = await runPostToolUseFailureHooks(
        context.toolName,
        context.args,
        result.failureOutput ?? result.output,
        result.errorType ?? "tool_error",
        context.toolCallId,
        context.workingDirectory,
        context.scopedAgentId,
        undefined,
        undefined,
      );
      postToolUseFailureFeedback = failureHookResult.feedback;
    } catch (error) {
      debugLog(
        "hooks",
        `PostToolUseFailure hook error (${context.debugLabel})`,
        error,
      );
    }
  }

  return [...postToolUseFeedback, ...postToolUseFailureFeedback];
}

function appendHookFeedbackToText(text: string, feedback: string[]): string {
  if (feedback.length === 0) return text;
  return `${text}\n\n[Hook feedback]:\n${feedback.join("\n")}`;
}

function appendHookFeedbackToToolReturn(
  toolReturn: ToolReturnContent,
  feedback: string[],
): ToolReturnContent {
  if (feedback.length === 0) return toolReturn;
  const feedbackMessage = `\n\n[Hook feedback]:\n${feedback.join("\n")}`;
  if (typeof toolReturn === "string") {
    return toolReturn + feedbackMessage;
  }
  return [...toolReturn, { type: "text" as const, text: feedbackMessage }];
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
  const redactions: InvocationSecretRedactions = new Map();
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
        toolReturn: `Error: Tool execution blocked by hook. ${feedback}`,
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
                  stripAnsi(
                    scrubModToolString(
                      chunk,
                      options.scopedAgentId,
                      redactions,
                    ),
                  ),
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
            return sendMessageStreamWithBackend(...sendArgs);
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
        options.scopedAgentId,
        redactions,
      );
      const stderr = scrubModToolLines(
        isStringArray(recordResult?.stderr) ? recordResult.stderr : undefined,
        options.scopedAgentId,
        redactions,
      );
      const toolStatus = getModToolStatus(result);
      const flattenedResponse = scrubModToolReturnContent(
        flattenToolResponse(result),
        options.scopedAgentId,
        redactions,
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
        options.scopedAgentId,
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

/**
 * Executes a tool by name with the provided arguments.
 *
 * @param name - The name of the tool to execute
 * @param args - Arguments object to pass to the tool
 * @param options - Optional execution options (abort signal, tool call ID, streaming callback)
 * @returns Promise with the tool's execution result including status and optional stdout/stderr
 */
async function executeToolInner(
  name: string,
  args: ToolArgs,
  options?: {
    signal?: AbortSignal;
    toolCallId?: string;
    onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
    toolContextId?: string;
    parentScope?: { agentId: string; conversationId: string };
    channelTurnSources?: ChannelTurnSource[];
    /** Called after a file-mutating tool (Edit, Write, MultiEdit) writes to disk.
     *  The listener layer uses this to broadcast the new content via WebSocket. */
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
  const workingDirectory =
    executionScope.workingDirectory ?? getCurrentWorkingDirectory();
  const scopedAgentId = executionScope.agentId ?? undefined;
  const modContext =
    context?.modContext ??
    toolExecutionModContext(executionScope, { workingDirectory });
  const activeModTools =
    context?.modTools ?? getAvailableModToolsRegistry(modContext);

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
    return executeModTool(name, modTool, eventArgs, executionScope, {
      signal: options?.signal,
      toolCallId: options?.toolCallId,
      onOutput: options?.onOutput,
      workingDirectory,
      scopedAgentId,
      modContext,
    });
  }

  // Check if this is an external tool (SDK-executed)
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
    return executeExternalTool(
      options?.toolCallId ?? `ext-${Date.now()}`,
      name,
      eventArgs as Record<string, unknown>,
      activeExternalExecutor,
      externalTool,
    );
  }

  const internalName = resolveInternalToolName(name, activeRegistry);
  if (!internalName) {
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

  const tool = activeRegistry.get(internalName);
  if (!tool) {
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

  const run = async (): Promise<ToolExecutionResult> => {
    // Run PreToolUse hooks - can block tool execution
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
        toolReturn: `Error: Tool execution blocked by hook. ${feedback}`,
        status: "error",
      };
    }

    // Apply rewritten tool input from PreToolUse hooks (e.g. rtk command rewrite)
    if (preHookResult.updatedInput) {
      args = {
        ...(args as Record<string, unknown>),
        ...preHookResult.updatedInput,
      };
    }
    if (options?.toolEndArgsRef) options.toolEndArgsRef.current = args;

    try {
      // Inject options for tools that support them without altering schemas
      let enhancedArgs = args;

      if (STREAMING_SHELL_TOOLS.has(internalName)) {
        if (options?.signal) {
          enhancedArgs = { ...enhancedArgs, signal: options.signal };
        }
        if (options?.onOutput) {
          enhancedArgs = {
            ...enhancedArgs,
            onOutput: (chunk: string, stream: "stdout" | "stderr") => {
              options.onOutput?.(
                stripAnsi(scrubSecretsFromString(chunk, scopedAgentId)),
                stream,
              );
            },
          };
        }

        // Inject secrets as environment variables instead of substituting into
        // the command string. This prevents shell metacharacters in secrets
        // (e.g. $$, backticks, quotes) from being interpreted by the shell.
        const command = enhancedArgs.command ?? enhancedArgs.cmd;
        const secretEnv =
          typeof command === "string" ||
          (Array.isArray(command) &&
            command.every((part) => typeof part === "string"))
            ? extractSecretEnvFromCommand(command, scopedAgentId)
            : {};
        if (Object.keys(secretEnv).length > 0) {
          enhancedArgs = { ...enhancedArgs, secretEnv };
        }
      }

      // Inject toolCallId, abort signal, and parent scope for Task tool
      if (internalName === "Task") {
        if (options?.toolCallId) {
          enhancedArgs = { ...enhancedArgs, toolCallId: options.toolCallId };
        }
        if (options?.signal) {
          enhancedArgs = { ...enhancedArgs, signal: options.signal };
        }
        if (options?.parentScope) {
          enhancedArgs = { ...enhancedArgs, parentScope: options.parentScope };
        }
      }

      // Inject scoped metadata for Skill tool.
      // In listener/desktop mode, relying on global agent context is unsafe
      // because multiple agent/conversation scopes can overlap in one process.
      if (internalName === "Skill" && options?.toolCallId) {
        enhancedArgs = { ...enhancedArgs, toolCallId: options.toolCallId };
      }
      if (internalName === "Skill" && options?.parentScope) {
        enhancedArgs = { ...enhancedArgs, parentScope: options.parentScope };
      }

      // Inject parent scope for MessageChannel tool (per-execution, not global singleton)
      if (internalName === "MessageChannel") {
        if (options?.parentScope) {
          enhancedArgs = { ...enhancedArgs, parentScope: options.parentScope };
        }
        if (options?.channelTurnSources?.length) {
          enhancedArgs = {
            ...enhancedArgs,
            channelTurnSources: options.channelTurnSources,
          };
        }
      }

      // Inject the execution context id for tools that need to mutate
      // turn-scoped execution state without touching global singletons.
      if (
        WORKTREE_TOOL_NAMES.has(internalName as ToolName) &&
        options?.toolContextId
      ) {
        enhancedArgs = {
          ...enhancedArgs,
          _executionContextId: options.toolContextId,
        };
      }

      const result = await tool.fn(enhancedArgs);
      const duration = Date.now() - startTime;

      // Broadcast file content after file-mutating tools so web clients update
      // in real time without waiting for fs.watch → file_changed → re-read.
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
          } catch {
            // Best-effort — don't fail the tool call if the read fails.
          }
        }
      }

      // Extract stdout/stderr if present (for bash tools)
      const recordResult = isRecord(result) ? result : undefined;
      const stdoutValue = recordResult?.stdout;
      const stderrValue = recordResult?.stderr;
      const stdout = isStringArray(stdoutValue) ? stdoutValue : undefined;
      const stderr = isStringArray(stderrValue) ? stderrValue : undefined;

      // Check if tool returned a status (e.g., Bash returns status: "error" on abort)
      const toolStatus = recordResult?.status === "error" ? "error" : "success";

      // Flatten the response to plain text
      let flattenedResponse = flattenToolResponse(result);

      // Scrub secret values + ANSI escape sequences from tool output so they
      // don't leak into agent context or render as garbage in downstream UIs.
      if (STREAMING_SHELL_TOOLS.has(internalName)) {
        const sanitize = (text: string) =>
          stripAnsi(scrubSecretsFromString(text, scopedAgentId));
        if (typeof flattenedResponse === "string") {
          flattenedResponse = sanitize(flattenedResponse);
        } else if (Array.isArray(flattenedResponse)) {
          flattenedResponse = flattenedResponse.map((block) =>
            block.type === "text"
              ? { ...block, text: sanitize(block.text) }
              : block,
          );
        }
        if (stdout) {
          for (let i = 0; i < stdout.length; i++) {
            const line = stdout[i];
            if (line !== undefined) {
              stdout[i] = sanitize(line);
            }
          }
        }
        if (stderr) {
          for (let i = 0; i < stderr.length; i++) {
            const line = stderr[i];
            if (line !== undefined) {
              stderr[i] = sanitize(line);
            }
          }
        }
      }

      // Track tool usage (calculate size for multimodal content)
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

      // Return the full response (truncation happens in UI layer only)
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
          // node:child_process AbortError may include code/message variants
          ("code" in error && error.code === "ABORT_ERR"));
      const errorType = isAbort
        ? "abort"
        : error instanceof Error
          ? error.name
          : "unknown";
      const errorMessage = isAbort
        ? INTERRUPTED_BY_USER
        : error instanceof Error
          ? error.message
          : String(error);

      // Track tool usage error
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

      // Don't console.error here - it pollutes the TUI
      // The error message is already returned in toolReturn
      return {
        toolReturn: finalErrorMessage,
        status: "error",
      };
    }
  };

  return runWithRuntimeContext(executionScope, run);
}

/**
 * Executes a tool and gives mods a chance to observe or replace the result via
 * the `tool_end` event. A handler returning `{ result: { status, output } }`
 * overrides what the agent sees (first handler wins). Only fires for string
 * results — multimodal/image results pass through unchanged. Delivery is
 * capability-gated (`events.tools`), so only enabled surfaces receive it.
 *
 * @param name - Name of the tool to execute
 * @param args - Arguments object to pass to the tool
 * @param options - Optional execution options (abort signal, tool call ID, streaming callback)
 * @returns Promise with the tool's execution result including status and optional stdout/stderr
 */
export async function executeTool(
  ...params: Parameters<typeof executeToolInner>
): Promise<ToolExecutionResult> {
  const [name, args, options] = params;
  const toolEndArgsRef = { current: args };
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
    ? { ...res, toolReturn: override.output, status: override.status }
    : res;
}

/**
 * Gets all loaded tool names (for passing to Letta agent creation).
 *
 * @returns Array of tool names
 */
export function getToolNames(): string[] {
  return Array.from(toolRegistry.keys());
}

/**
 * Returns all Letta Code tool names known to this build, regardless of what is currently loaded.
 * Useful for unlinking/removing tools when switching providers/models.
 */
export function getAllLettaToolNames(): string[] {
  return [...TOOL_NAMES];
}

/**
 * Gets all loaded tool schemas (for inspection/debugging).
 *
 * @returns Array of tool schemas
 */
export function getToolSchemas(): ToolSchema[] {
  const builtInSchemas = Array.from(
    withDynamicMessageChannelCache(toolRegistry).values(),
  ).map((tool) => tool.schema);
  const modSchemas = Array.from(getAvailableModToolsRegistry().values()).map(
    (tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as JsonSchema,
    }),
  );
  return [...builtInSchemas, ...modSchemas];
}

/**
 * Gets a single tool's schema by name.
 *
 * @param name - The tool name
 * @returns The tool schema or undefined if not found
 */
export function getToolSchema(name: string): ToolSchema | undefined {
  const internalName = resolveInternalToolName(name);
  if (internalName) {
    return withDynamicMessageChannelCache(toolRegistry).get(internalName)
      ?.schema;
  }
  const modTool = getModToolDefinition(name);
  if (modTool) {
    return {
      name: modTool.name,
      description: modTool.description,
      input_schema: modTool.parameters as JsonSchema,
    };
  }
  const externalTool = getExternalToolDefinition(name);
  if (externalTool) {
    return {
      name: externalTool.name,
      description: externalTool.description,
      input_schema: externalTool.parameters as JsonSchema,
    };
  }
  return undefined;
}

export async function refreshDynamicChannelToolsInLoadedRegistry(): Promise<void> {
  const activeChannels = getActiveChannelIds();
  if (activeChannels.length === 0) {
    toolRegistry.delete("MessageChannel");
    return;
  }

  const definition = TOOL_DEFINITIONS.MessageChannel;
  if (!definition?.impl) {
    throw new Error("Tool implementation not found for MessageChannel");
  }

  const resolvedTool = await maybeResolveDynamicChannelTool(
    "MessageChannel",
    definition.description,
    definition.schema,
  );
  toolRegistry.set("MessageChannel", {
    schema: {
      name: "MessageChannel",
      description: resolvedTool.description,
      input_schema: resolvedTool.input_schema as JsonSchema,
    },
    modelForm: functionToolForm({
      description: resolvedTool.description,
      parameters: resolvedTool.input_schema as JsonSchema,
    }),
    fn: definition.impl,
  });
}

/**
 * Clears the tool registry (useful for testing).
 */
export function clearTools(): void {
  toolRegistry.clear();
}

/**
 * Clears the tool registry with lock protection.
 * Acquires the switch lock, clears the registry, then releases the lock.
 * This ensures sendMessageStream() waits for the clear to complete.
 */
export function clearToolsWithLock(): void {
  acquireSwitchLock();
  try {
    toolRegistry.clear();
  } finally {
    releaseSwitchLock();
  }
}
