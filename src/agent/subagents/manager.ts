/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { spawn } from "node:child_process";
import { getAvailableModelHandles } from "@/agent/available-models";
import { getConversationId, getCurrentAgentId } from "@/agent/context";
import { getDefaultModelForTier, resolveModel } from "@/agent/model";
import recallSubagentPrompt from "@/agent/prompts/recall_subagent.md";
import recallSubagentLocalPrompt from "@/agent/prompts/recall_subagent_local.md";
import {
  addToolCall,
  emitStreamEvent,
  updateSubagent,
} from "@/agent/subagent-state.js";
import { wrapSubagentLauncher } from "@/agent/subagents/sandbox";
import {
  type BackendMode,
  getBackend,
  getLocalBackendStorageDir,
} from "@/backend";
import { getBillingTier } from "@/backend/api/metadata";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";
import { buildAgentReference } from "@/cli/helpers/app-urls";
import {
  INTERRUPTED_BY_USER,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "@/constants";
import { cliPermissions } from "@/permissions/cli-permissions-instance";
import { resolveAllowedMemoryRoots } from "@/permissions/memory-paths";
import { sessionPermissions } from "@/permissions/session";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
  type InheritedChannelContextPayload,
  LETTA_INHERITED_CHANNEL_CONTEXT_ENV,
  type RuntimeContextSnapshot,
} from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  resolveEntryScriptPath,
  resolveLettaInvocation,
} from "@/tools/impl/shell-env";
import { debugLog, debugWarn } from "@/utils/debug";
import { getErrorMessage } from "@/utils/error";
import {
  getAllSubagentConfigs,
  type SubagentConfig,
  type SubagentLaunchProfile,
} from ".";
import {
  estimateStartupContextTokens,
  REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "./context-budget";

// ============================================================================
// Constants
// ============================================================================

/**
 * Subagent types that don't need server-side base tools (web_search,
 * fetch_webpage). These agents operate on local memory/git state and have
 * no use for internet access. Spawning them with `--base-tools none`
 * keeps their tool list minimal.
 *
 * fork/recall are excluded because they deploy the parent agent and
 * never trigger fresh agent creation, so base tools are out of scope.
 */
const NO_BASE_TOOL_SUBAGENT_TYPES = new Set([
  "reflection",
  "memory",
  "history-analyzer",
  "init",
]);

// ============================================================================
// Types
// ============================================================================

/**
 * Subagent execution result
 */
export interface SubagentResult {
  agentId: string;
  conversationId?: string;
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
  stepCount?: number;
  durationMs?: number;
}

/**
 * State tracked during subagent execution
 */
interface ExecutionState {
  agentId: string | null;
  conversationId: string | null;
  finalResult: string | null;
  finalError: string | null;
  resultStats: {
    durationMs: number;
    totalTokens: number;
    stepCount?: number;
  } | null;
  displayedToolCalls: Set<string>;
  pendingToolCalls: Map<string, { name: string; args: string }>;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get the primary agent's model ID
 * Fetches from API and resolves to a known model ID
 */
export function getModelHandleFromAgent(agent: {
  model?: string | null;
  model_settings?: { provider_type?: unknown } | null;
  llm_config?: { model_endpoint_type?: string | null; model?: string | null };
}): string | null {
  const directModel = agent.model;
  if (directModel?.includes("/")) {
    return directModel;
  }
  const settingsProvider = agent.model_settings?.provider_type;
  if (typeof settingsProvider === "string" && directModel) {
    return `${settingsProvider}/${directModel}`;
  }
  const endpoint = agent.llm_config?.model_endpoint_type;
  const model = agent.llm_config?.model;
  if (endpoint && model) {
    return `${endpoint}/${model}`;
  }
  return directModel || model || null;
}

async function getPrimaryAgentModelHandle(
  scope: { agentId?: string | null; conversationId?: string | null } = {},
): Promise<{
  handle: string | null;
  agent: {
    model?: string | null;
    name?: string | null;
    model_settings?: { provider_type?: unknown } | null;
    llm_config?: { model_endpoint_type?: string | null; model?: string | null };
  } | null;
}> {
  try {
    const agentId = scope.agentId ?? getCurrentAgentId();
    const agent = await getBackend().retrieveAgent(agentId);
    const conversationId = scope.conversationId;
    if (conversationId && conversationId !== "default") {
      try {
        const conversation =
          await getBackend().retrieveConversation(conversationId);
        const conversationHandle = getModelHandleFromAgent(conversation);
        if (conversationHandle) {
          return { handle: conversationHandle, agent };
        }
      } catch {
        // Fall back to the agent default if the conversation is not available.
      }
    }
    return { handle: getModelHandleFromAgent(agent), agent };
  } catch {
    return { handle: null, agent: null };
  }
}

async function getCurrentBillingTier(): Promise<string | null> {
  return getBillingTier();
}

/**
 * Check if an error message indicates an unsupported provider
 */
function isProviderNotSupportedError(errorOutput: string): boolean {
  return (
    errorOutput.includes("Provider") &&
    errorOutput.includes("is not supported") &&
    errorOutput.includes("supported providers:")
  );
}

const BYOK_PROVIDER_TO_BASE: Record<string, string> = {
  "lc-anthropic": "anthropic",
  "lc-openai": "openai",
  "lc-zai": "zai",
  "lc-gemini": "google_ai",
  "lc-openrouter": "openrouter",
  "lc-minimax": "minimax",
  "lc-bedrock": "bedrock",
  "chatgpt-plus-pro": "chatgpt-plus-pro",
};

function getProviderPrefix(handle: string): string | null {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return null;
  return handle.slice(0, slashIndex);
}

function swapProviderPrefix(
  parentHandle: string,
  recommendedHandle: string,
): string | null {
  const parentProvider = getProviderPrefix(parentHandle);
  if (!parentProvider) return null;

  const baseProvider = BYOK_PROVIDER_TO_BASE[parentProvider];
  if (!baseProvider) return null;

  const recommendedProvider = getProviderPrefix(recommendedHandle);
  if (!recommendedProvider || recommendedProvider !== baseProvider) return null;

  const modelPortion = recommendedHandle.slice(recommendedProvider.length + 1);
  return `${parentProvider}/${modelPortion}`;
}

function isInheritModel(model: string | null | undefined): boolean {
  return model?.trim().toLowerCase() === "inherit";
}

export async function resolveSubagentModel(options: {
  userModel?: string;
  recommendedModel?: string;
  parentModelHandle?: string | null;
  billingTier?: string | null;
  availableHandles?: Set<string>;
  subagentType?: string;
  backendMode?: BackendMode;
}): Promise<string | null> {
  const { userModel, recommendedModel, parentModelHandle, billingTier } =
    options;
  const isFreeTier = billingTier?.toLowerCase() === "free";
  const userRequestedInheritance = isInheritModel(userModel);
  const effectiveRecommendedModel = userRequestedInheritance
    ? "inherit"
    : recommendedModel;

  if (userModel && !userRequestedInheritance) return userModel;

  // Local backend has no server-side auto router. If the parent agent is
  // already running successfully on a local model, spawned subagents should use
  // that exact model instead of resolving auto/auto-memory to a provider
  // default that may not match the active session.
  if (options.backendMode === "local" && parentModelHandle) {
    return parentModelHandle;
  }

  if (options.subagentType === "reflection") {
    if (
      effectiveRecommendedModel &&
      !isInheritModel(effectiveRecommendedModel)
    ) {
      const recommendedHandle = resolveModel(effectiveRecommendedModel);
      if (recommendedHandle) {
        return recommendedHandle;
      }
    }

    return "letta/auto-memory";
  }

  let recommendedHandle: string | null = null;
  if (effectiveRecommendedModel && !isInheritModel(effectiveRecommendedModel)) {
    recommendedHandle = resolveModel(effectiveRecommendedModel);
  }

  let availableHandles: Set<string> | null = options.availableHandles ?? null;
  const isAvailable = async (handle: string): Promise<boolean> => {
    try {
      if (!availableHandles) {
        const result = await getAvailableModelHandles();
        availableHandles = result.handles;
      }
      return availableHandles.has(handle);
    } catch {
      return false;
    }
  };

  // Free-tier default for subagents: auto-fast, when available.
  const freeTierDefaultHandle = isFreeTier ? resolveModel("auto-fast") : null;
  if (freeTierDefaultHandle && (await isAvailable(freeTierDefaultHandle))) {
    return freeTierDefaultHandle;
  }

  // Free-tier fallback default: auto, when available.
  if (isFreeTier) {
    const defaultHandle = getDefaultModelForTier(billingTier);
    if (defaultHandle && (await isAvailable(defaultHandle))) {
      return defaultHandle;
    }
  }

  if (parentModelHandle) {
    const parentProvider = getProviderPrefix(parentModelHandle);
    const parentBaseProvider = parentProvider
      ? BYOK_PROVIDER_TO_BASE[parentProvider]
      : null;
    const parentIsByok = !!parentBaseProvider;

    if (recommendedHandle) {
      const recommendedProvider = getProviderPrefix(recommendedHandle);

      if (parentIsByok) {
        if (recommendedProvider === parentProvider) {
          if (await isAvailable(recommendedHandle)) {
            return recommendedHandle;
          }
        } else {
          const swapped = swapProviderPrefix(
            parentModelHandle,
            recommendedHandle,
          );
          if (swapped && (await isAvailable(swapped))) {
            return swapped;
          }
        }

        return parentModelHandle;
      }

      if (await isAvailable(recommendedHandle)) {
        return recommendedHandle;
      }
    }

    return parentModelHandle;
  }

  if (recommendedHandle && (await isAvailable(recommendedHandle))) {
    return recommendedHandle;
  }

  // Non-free fallback default: auto, when available.
  const defaultHandle = getDefaultModelForTier(billingTier);
  if (defaultHandle && (await isAvailable(defaultHandle))) {
    return defaultHandle;
  }

  return recommendedHandle;
}

/**
 * Record a tool call to the state store
 */
function recordToolCall(
  subagentId: string,
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  displayedToolCalls: Set<string>,
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);
  addToolCall(subagentId, toolCallId, toolName, toolArgs);
}

/**
 * Handle an init event from the subagent stream
 */
function handleInitEvent(
  event: { agent_id?: string; conversation_id?: string },
  state: ExecutionState,
  subagentId: string,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = buildAgentReference(event.agent_id, {
      conversationId: event.conversation_id,
    });
    updateSubagent(subagentId, { agentId: event.agent_id, agentURL });
  }
  if (event.conversation_id) {
    state.conversationId = event.conversation_id;
  }
}

/**
 * Handle an approval request message event
 */
function handleApprovalRequestEvent(
  event: { tool_calls?: unknown[]; tool_call?: unknown },
  state: ExecutionState,
): void {
  const toolCalls = Array.isArray(event.tool_calls)
    ? event.tool_calls
    : event.tool_call
      ? [event.tool_call]
      : [];

  for (const toolCall of toolCalls) {
    const tc = toolCall as {
      tool_call_id?: string;
      name?: string;
      arguments?: string;
    };
    const id = tc.tool_call_id;
    if (!id) continue;

    const prev = state.pendingToolCalls.get(id) || { name: "", args: "" };
    const name = tc.name || prev.name;
    const args = prev.args + (tc.arguments || "");
    state.pendingToolCalls.set(id, { name, args });
  }
}

/**
 * Handle an auto_approval event
 */
function handleAutoApprovalEvent(
  event: {
    tool_call?: { tool_call_id?: string; name?: string; arguments?: string };
  },
  state: ExecutionState,
  subagentId: string,
): void {
  const tc = event.tool_call;
  if (!tc) return;
  const { tool_call_id, name, arguments: tool_args = "{}" } = tc;
  if (tool_call_id && name) {
    recordToolCall(
      subagentId,
      tool_call_id,
      name,
      tool_args,
      state.displayedToolCalls,
    );
  }
}

/**
 * Handle a result event
 */
function handleResultEvent(
  event: {
    result?: string;
    is_error?: boolean;
    duration_ms?: number;
    usage?: { total_tokens?: number; step_count?: number };
    num_turns?: number;
  },
  state: ExecutionState,
  subagentId: string,
): void {
  state.finalResult = event.result || "";
  state.resultStats = {
    durationMs: event.duration_ms || 0,
    totalTokens: event.usage?.total_tokens || 0,
    stepCount:
      typeof event.usage?.step_count === "number"
        ? event.usage.step_count
        : undefined,
  };

  if (event.is_error) {
    state.finalError = event.result || "Unknown error";
  } else {
    // Record any pending tool calls that weren't auto-approved
    for (const [id, { name, args }] of state.pendingToolCalls.entries()) {
      if (name && !state.displayedToolCalls.has(id)) {
        recordToolCall(
          subagentId,
          id,
          name,
          args || "{}",
          state.displayedToolCalls,
        );
      }
    }
  }

  // Update state store with final stats
  updateSubagent(subagentId, {
    totalTokens: state.resultStats.totalTokens,
    durationMs: state.resultStats.durationMs,
  });
}

/**
 * Process a single JSON event from the subagent stream
 */
function processStreamEvent(
  line: string,
  state: ExecutionState,
  subagentId: string,
): void {
  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case "init":
      case "system":
        // Handle both legacy "init" type and new "system" type with subtype "init"
        if (event.type === "init" || event.subtype === "init") {
          handleInitEvent(event, state, subagentId);
        }
        break;

      case "message":
        if (event.message_type === "approval_request_message") {
          handleApprovalRequestEvent(event, state);
        } else {
          // Forward non-approval message events for WS streaming to the web UI.
          // Approval requests are internal to the subagent's permission flow.
          emitStreamEvent(subagentId, event);
        }
        break;

      case "auto_approval":
        handleAutoApprovalEvent(event, state, subagentId);
        break;

      case "result":
        handleResultEvent(event, state, subagentId);
        break;

      case "error":
        state.finalError = event.error || event.message || "Unknown error";
        break;
    }
  } catch {
    // Not valid JSON, ignore
  }
}

/**
 * Parse the final result from stdout if not captured during streaming
 */
function parseResultFromStdout(
  stdout: string,
  agentId: string | null,
): SubagentResult {
  const lines = stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  if (stdout.trim().length === 0) {
    debugWarn(
      "subagent",
      `parseResultFromStdout: stdout is empty (agentId=${agentId})`,
    );
  }

  try {
    const result = JSON.parse(lastLine);

    if (result.type === "result") {
      return {
        agentId: agentId || "",
        report: result.result || "",
        success: !result.is_error,
        error: result.is_error ? result.result || "Unknown error" : undefined,
        stepCount:
          typeof result.usage?.step_count === "number"
            ? result.usage.step_count
            : undefined,
        durationMs:
          typeof result.duration_ms === "number"
            ? result.duration_ms
            : undefined,
      };
    }

    debugWarn(
      "subagent",
      `parseResultFromStdout: last line parsed as JSON but type=${result.type}, not "result" (agentId=${agentId})`,
    );
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: "Unexpected output format from subagent",
    };
  } catch (parseError) {
    debugWarn(
      "subagent",
      `parseResultFromStdout: JSON.parse failed on last line (${lastLine.length} chars): ${getErrorMessage(parseError)}. ` +
        `Total stdout: ${stdout.length} chars, ${lines.length} lines. Last line: ${lastLine.slice(0, 200)}`,
    );
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: `Failed to parse subagent output: ${getErrorMessage(parseError)}`,
    };
  }
}

interface ResolveSubagentLauncherOptions {
  env?: NodeJS.ProcessEnv;
  argv?: string[];
  execPath?: string;
  platform?: NodeJS.Platform;
  cwd?: string;
}

interface SubagentLauncher {
  command: string;
  args: string[];
}

export function resolveSubagentWorkingDirectory(
  env: NodeJS.ProcessEnv = process.env,
  fallbackCwd: string = getCurrentWorkingDirectory(),
  options: {
    subagentType?: string;
    launchProfile?: SubagentLaunchProfile;
    inheritedPrimaryRoot?: string | null;
  } = {},
): string {
  if (
    options.subagentType === "reflection" &&
    options.launchProfile === "memory-subagent" &&
    options.inheritedPrimaryRoot
  ) {
    return options.inheritedPrimaryRoot;
  }

  return env.USER_CWD || fallbackCwd;
}

export function resolveSubagentLauncher(
  cliArgs: string[],
  options: ResolveSubagentLauncherOptions = {},
): SubagentLauncher {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const execPath = options.execPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const cwd = options.cwd ?? process.cwd();

  const invocation = resolveLettaInvocation(env, argv, execPath, cwd);
  if (invocation) {
    return {
      command: invocation.command,
      args: [...invocation.args, ...cliArgs],
    };
  }

  const currentScript = argv[1] || "";
  const resolvedCurrentScript = resolveEntryScriptPath(currentScript, cwd);

  // Preserve historical subagent behavior: any .ts entrypoint uses runtime binary.
  if (currentScript.endsWith(".ts")) {
    return {
      command: execPath,
      args: [resolvedCurrentScript, ...cliArgs],
    };
  }

  // Windows cannot reliably spawn bundled .js directly (EFTYPE/EINVAL).
  if (currentScript.endsWith(".js") && platform === "win32") {
    return {
      command: execPath,
      args: [resolvedCurrentScript, ...cliArgs],
    };
  }

  if (currentScript.endsWith(".js")) {
    return {
      command: resolvedCurrentScript,
      args: cliArgs,
    };
  }

  return {
    command: "letta",
    args: cliArgs,
  };
}

export interface ComposeSubagentChildEnvOptions {
  /** The env of the process spawning the subagent (parent). */
  parentProcessEnv: NodeJS.ProcessEnv;
  /** Active backend mode to force in the child CLI process. */
  backendMode?: BackendMode;
  /** Local backend flatfile root to forward when backendMode="local". */
  localBackendStorageDir?: string | null;
  /** Parent agent ID. When present, sets LETTA_PARENT_AGENT_ID so prompts,
   * scripts, and the cross-agent guard can identify the immediate parent. */
  parentAgentId: string | undefined;
  /** The subagent config's declared launch profile. Subagents with the memory-subagent profile
   * operate on the parent's memory filesystem. */
  launchProfile: SubagentLaunchProfile | undefined;
  /** Primary memory root for the parent, used by the memory-subagent launch
   * profile to point the child at its parent's memfs repo. Null means memfs
   * disabled or unresolvable — child operates without a MEMORY_DIR. */
  inheritedPrimaryRoot: string | null;
  /** Forwarded API key to avoid per-subagent keychain lookups. */
  inheritedApiKey?: string | null;
  /** Forwarded base URL to avoid per-subagent settings lookups. */
  inheritedBaseUrl?: string | null;
  /** Optional path to a transcript payload file, exposed to the child as
   * the TRANSCRIPT_PATH env var. Used by reflection subagents so the prompt
   * can reference `$TRANSCRIPT_PATH` (resolved via Bash) instead of
   * interpolating the absolute path. Unset → no TRANSCRIPT_PATH in child. */
  transcriptPath?: string | null;
  /** Serializable channel scope for child processes. Execution-context IDs are
   * process-local, so channel scope must be copied explicitly across spawn. */
  inheritedChannelContext?: InheritedChannelContextPayload | null;
}

function buildInheritedChannelContextPayload(
  runtimeContext: RuntimeContextSnapshot | undefined,
): InheritedChannelContextPayload | null {
  const channelToolScope = runtimeContext?.channelToolScope;
  const channelTurnSources = runtimeContext?.channelTurnSources ?? [];
  if (!channelToolScope?.channels.length && channelTurnSources.length === 0) {
    return null;
  }

  return {
    ...(channelToolScope?.channels.length ? { channelToolScope } : {}),
    ...(channelTurnSources.length
      ? { channelTurnSources: [...channelTurnSources] }
      : {}),
  };
}

/**
 * Compose the env a subagent child process should be spawned with.
 *
 * The parent identity marker and filesystem pointer are intentionally
 * decoupled:
 *
 *   - LETTA_PARENT_AGENT_ID identifies the immediate parent. Subagents never
 *     inherit a broad cross-agent memory-guard opt-out from the parent.
 *
 *   - MEMORY_DIR / LETTA_MEMORY_DIR are only overridden when the subagent
 *     declares the memory-subagent launch profile. Those subagents operate on
 *     the parent's memory as their working filesystem (reflection, memory,
 *     init, history-analyzer). Other subagents keep whatever MEMORY_DIR they
 *     inherited from the parent process (usually unset).
 *
 * Pure function, no side effects — straightforward to unit-test.
 */
export function composeSubagentChildEnv(
  options: ComposeSubagentChildEnvOptions,
): NodeJS.ProcessEnv {
  const {
    parentProcessEnv,
    backendMode,
    localBackendStorageDir,
    parentAgentId,
    launchProfile,
    inheritedPrimaryRoot,
    inheritedApiKey,
    inheritedBaseUrl,
    transcriptPath,
    inheritedChannelContext,
  } = options;

  const childEnv: NodeJS.ProcessEnv = {
    ...parentProcessEnv,
    ...(inheritedApiKey && { LETTA_API_KEY: inheritedApiKey }),
    ...(inheritedBaseUrl && { LETTA_BASE_URL: inheritedBaseUrl }),
    LETTA_CODE_AGENT_ROLE: "subagent",
    ...(parentAgentId && { LETTA_PARENT_AGENT_ID: parentAgentId }),
    ...(transcriptPath && { TRANSCRIPT_PATH: transcriptPath }),
    ...(inheritedChannelContext && {
      [LETTA_INHERITED_CHANNEL_CONTEXT_ENV]: JSON.stringify(
        inheritedChannelContext,
      ),
    }),
  };

  if (backendMode === "local") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
    if (localBackendStorageDir) {
      childEnv.LETTA_LOCAL_BACKEND_DIR = localBackendStorageDir;
    }
  } else if (backendMode === "api") {
    childEnv.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "0";
  }

  // Only subagents with the memory-subagent profile get MEMORY_DIR pointed at the parent. Other
  // subagents either have their own memfs (if memfs-enabled) or no MEMORY_DIR
  // at all — their tools will surface resolution errors appropriately.
  if (launchProfile === "memory-subagent") {
    if (inheritedPrimaryRoot) {
      childEnv.MEMORY_DIR = inheritedPrimaryRoot;
      childEnv.LETTA_MEMORY_DIR = inheritedPrimaryRoot;
    } else {
      delete childEnv.MEMORY_DIR;
      delete childEnv.LETTA_MEMORY_DIR;
    }
  }

  return childEnv;
}

export function resolveSubagentInheritedPrimaryRoot(options: {
  backendMode: BackendMode;
  parentAgentId: string | undefined;
  inheritedPrimaryRoot: string | null;
  localBackendStorageDir?: string | null;
}): string | null {
  if (options.backendMode === "local" && options.parentAgentId) {
    return getLocalBackendMemoryFilesystemRoot(
      options.parentAgentId,
      options.localBackendStorageDir ?? getLocalBackendStorageDir(),
    );
  }
  return options.inheritedPrimaryRoot;
}

// ============================================================================
// Core Functions
// ============================================================================

function getReflectionStartupNotice(): string {
  return `[Reflection startup context truncated: system prompt + initial message are capped at ~${REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT.toLocaleString()} estimated tokens. Some parent memory preview content was omitted; read files directly from MEMORY_DIR if needed.]`;
}

function buildMinimalParentMemorySection(maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const section = `<parent_memory>\n${notice}\n</parent_memory>`;
  if (section.length <= maxChars) {
    return section;
  }
  return section.slice(0, Math.max(0, maxChars));
}

function shrinkParentMemorySection(section: string, maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const treeMatch = section.match(
    /<memory_filesystem>[\s\S]*?<\/memory_filesystem>/,
  );
  const prefix = "<parent_memory>\n";
  const suffix = "\n</parent_memory>";

  const tree = treeMatch?.[0];
  if (tree) {
    const candidate = `${prefix}${tree}\n${notice}${suffix}`;
    if (candidate.length <= maxChars) {
      return candidate;
    }
  }

  return buildMinimalParentMemorySection(maxChars);
}

function hardTruncateReflectionPrompt(
  prompt: string,
  maxChars: number,
): string {
  const notice = `\n${getReflectionStartupNotice()}`;
  if (maxChars <= notice.length) {
    return notice.slice(0, Math.max(0, maxChars));
  }
  return `${prompt.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

function capReflectionStartupPrompt(
  type: string,
  systemPrompt: string,
  userPrompt: string,
): string {
  if (type !== "reflection") {
    return userPrompt;
  }

  const estimatedTokens = estimateStartupContextTokens(
    `${systemPrompt}\n${userPrompt}`,
  );
  if (estimatedTokens <= REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT) {
    return userPrompt;
  }

  const allowedPromptChars = Math.max(
    0,
    REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT - systemPrompt.length - 1,
  );
  const parentMemoryMatch = userPrompt.match(
    /<parent_memory>[\s\S]*?<\/parent_memory>/,
  );

  if (parentMemoryMatch?.index !== undefined) {
    const start = parentMemoryMatch.index;
    const end = start + parentMemoryMatch[0].length;
    const outsideChars = userPrompt.length - parentMemoryMatch[0].length;
    const parentMemoryBudget = Math.max(0, allowedPromptChars - outsideChars);
    const replacement = shrinkParentMemorySection(
      parentMemoryMatch[0],
      parentMemoryBudget,
    );
    const candidate = `${userPrompt.slice(0, start)}${replacement}${userPrompt.slice(end)}`;
    if (candidate.length <= allowedPromptChars) {
      return candidate;
    }
  }

  return hardTruncateReflectionPrompt(userPrompt, allowedPromptChars);
}

export function buildSubagentPrompt(
  type: string,
  config: SubagentConfig,
  userPrompt: string,
): string {
  return capReflectionStartupPrompt(type, config.systemPrompt, userPrompt);
}

interface BuildSubagentArgsOptions {
  backendMode?: BackendMode;
  promptTransport?: "argv" | "stdin";
  extraTools?: string[];
  parentAgentId?: string | null;
}

/**
 * Build CLI arguments for spawning a subagent
 */
export function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  options: BuildSubagentArgsOptions = {},
): string[] {
  const args: string[] = [];
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  if (options.backendMode) {
    args.push("--backend", options.backendMode);
  }

  if (isDeployingExisting) {
    // Deploy existing agent/conversation
    if (existingConversationId) {
      // conversation_id is sufficient (headless derives agent from it)
      args.push("--conv", existingConversationId);
    } else if (existingAgentId) {
      // agent_id only - use --new to create a new conversation for thread safety
      // (multiple parallel calls to the same agent need separate conversations)
      args.push("--agent", existingAgentId, "--new");
    }
    // Don't pass --system (existing agent keeps its prompt)
    // Don't pass --model (existing agent keeps its model)
  } else {
    // Create new agent (original behavior)
    args.push("--new-agent", "--system", type);
    const subagentTags = [`type:${type}`];
    if (options.parentAgentId) {
      subagentTags.push(`parent:${options.parentAgentId}`);
    }
    args.push("--tags", subagentTags.join(","));
    // Newly spawned subagents are stateless (non-memfs). The headless
    // entrypoint derives this from LETTA_CODE_AGENT_ROLE=subagent — no CLI
    // flag needed, and no user-facing opt-out exists.
    if (model) {
      args.push("--model", model);
    }

    // Reflection-specific startup flags: match the memory_reflection training
    // env so the trained policy sees identical prompt suffixes and skill
    // availability at inference time as it did during training.
    if (type === "reflection") {
      args.push("--no-system-info-reminder");
      args.push("--no-skills");
    }

    // Skip server-side base tools (web_search, fetch_webpage) for subagents
    // that operate purely on local memory/git state.
    if (NO_BASE_TOOL_SUBAGENT_TYPES.has(type)) {
      args.push("--base-tools", "none");
    }
  }

  if (options.promptTransport !== "stdin") {
    args.push("-p", buildSubagentPrompt(type, config, userPrompt));
  }
  args.push("--output-format", "stream-json");
  args.push("--permission-mode", "unrestricted");

  // Build list of auto-approved tools:
  // 1. Inherit from parent (CLI + session rules)
  // 2. Add subagent's allowed tools (so they don't hang on approvals)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const subagentTools =
    config.allowedTools !== "all" && Array.isArray(config.allowedTools)
      ? config.allowedTools
      : [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules, ...subagentTools]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }

  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  // Add tool filtering if specified (applies to both new and existing agents)
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    const scopedTools = Array.from(
      new Set([...(config.allowedTools ?? []), ...(options.extraTools ?? [])]),
    );
    args.push("--tools", scopedTools.join(","));
  }

  // Add max turns limit if specified
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  // Pre-load skills specified in the subagent config
  if (config.skills.length > 0) {
    args.push("--pre-load-skills", config.skills.join(","));
  }

  return args;
}

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 */
async function executeSubagent(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  baseURL: string,
  subagentId: string,
  isRetry = false,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  parentAgentIdOverride?: string,
  transcriptPath?: string,
): Promise<SubagentResult> {
  // Check if already aborted before starting
  if (signal?.aborted) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: INTERRUPTED_BY_USER,
    };
  }

  // Update the state with the model being used (may differ on retry/fallback)
  if (model) {
    updateSubagent(subagentId, { model });
  }

  try {
    const activeBackend = getBackend();
    const backendMode: BackendMode = activeBackend.capabilities.localMemfs
      ? "local"
      : "api";
    const runtimeContext = getRuntimeContext();
    const inheritedChannelContext =
      buildInheritedChannelContextPayload(runtimeContext);
    const boundedUserPrompt = buildSubagentPrompt(type, config, userPrompt);

    let parentAgentId = parentAgentIdOverride;
    if (!parentAgentId) {
      try {
        parentAgentId = getCurrentAgentId();
      } catch {
        // Context not available — subagent will have no parent scope.
      }
    }

    const cliArgs = buildSubagentArgs(
      type,
      config,
      model,
      userPrompt,
      existingAgentId,
      existingConversationId,
      maxTurns,
      {
        backendMode,
        promptTransport: "stdin",
        parentAgentId,
        extraTools:
          config.fork && inheritedChannelContext
            ? ["MessageChannel"]
            : undefined,
      },
    );

    const launcher = resolveSubagentLauncher(cliArgs);

    // Resolve auth once in parent and forward to child to avoid per-subagent
    // keychain lookups under high parallel fan-out.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
    const inheritedBaseUrl =
      process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL;
    const inheritedMemoryRoots = resolveAllowedMemoryRoots({
      currentAgentId: parentAgentId ?? null,
    });
    const localBackendStorageDir =
      backendMode === "local" ? getLocalBackendStorageDir() : null;
    const inheritedPrimaryRoot = resolveSubagentInheritedPrimaryRoot({
      backendMode,
      parentAgentId,
      inheritedPrimaryRoot: inheritedMemoryRoots.primaryRoot,
      localBackendStorageDir,
    });
    const subagentWorkingDirectory = resolveSubagentWorkingDirectory(
      process.env,
      getCurrentWorkingDirectory(),
      {
        subagentType: type,
        launchProfile: config.launchProfile,
        inheritedPrimaryRoot,
      },
    );
    const childEnv = composeSubagentChildEnv({
      parentProcessEnv: {
        ...process.env,
        USER_CWD: subagentWorkingDirectory,
      },
      backendMode,
      localBackendStorageDir,
      parentAgentId,
      launchProfile: config.launchProfile,
      inheritedPrimaryRoot,
      inheritedApiKey,
      inheritedBaseUrl,
      transcriptPath,
      inheritedChannelContext,
    });

    // Optionally confine subagents with the memory-subagent profile to an OS filesystem sandbox.
    // Returns null (spawn unchanged) when disabled, not applicable, or no
    // backend is available on this host.
    const sandbox = wrapSubagentLauncher({
      launcher,
      launchProfile: config.launchProfile,
      backendMode,
      memoryRoots: inheritedMemoryRoots.roots,
      inheritedPrimaryRoot,
      localBackendStorageDir,
    });
    const spawnLauncher = sandbox
      ? { command: sandbox.command, args: sandbox.args }
      : launcher;
    const spawnEnv = sandbox
      ? { ...childEnv, ...sandbox.sandboxEnv }
      : childEnv;
    if (sandbox) {
      debugLog(
        "subagent",
        `memory subagent child sandboxed via ${sandbox.backend}`,
      );
    }

    const proc = spawn(spawnLauncher.command, spawnLauncher.args, {
      cwd: subagentWorkingDirectory,
      env: spawnEnv,
    });
    proc.stdin.on("error", () => {});
    proc.stdin.end(boundedUserPrompt);

    // Consider execution "running" once the child process has successfully spawned.
    // This avoids waiting on subagent init events (e.g. agentURL) to reflect progress.
    proc.once("spawn", () => {
      updateSubagent(subagentId, { status: "running" });
    });

    // Set up abort handler to kill the child process
    let wasAborted = false;
    const abortHandler = () => {
      wasAborted = true;
      proc.kill("SIGTERM");
    };
    signal?.addEventListener("abort", abortHandler);

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Initialize execution state
    const state: ExecutionState = {
      agentId: existingAgentId || null,
      conversationId: existingConversationId || null,
      finalResult: null,
      finalError: null,
      resultStats: null,
      displayedToolCalls: new Set(),
      pendingToolCalls: new Map(),
    };

    // Parse child stdout manually instead of using readline. This keeps the
    // stream handling simple and avoids Bun/runtime-specific instability in
    // nested child-process line readers.
    let stdoutBuffer = "";
    proc.stdout.on("data", (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      stdoutChunks.push(chunk);
      stdoutBuffer += chunk.toString("utf-8");

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        processStreamEvent(line, state, subagentId);
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    // Wait for process to complete
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    });

    // Ensure the trailing partial line is processed before completing.
    // Without this, late tool events can be dropped before Task marks completion.
    if (stdoutBuffer.length > 0) {
      processStreamEvent(stdoutBuffer, state, subagentId);
    }

    // Clean up abort listener
    signal?.removeEventListener("abort", abortHandler);

    // Check if process was aborted by user
    if (wasAborted) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: INTERRUPTED_BY_USER,
      };
    }

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // Check if this is a provider-not-supported error and we haven't retried yet
      if (!isRetry && isProviderNotSupportedError(stderr)) {
        const { handle: primaryModel } = await getPrimaryAgentModelHandle({
          agentId: parentAgentIdOverride,
        });
        if (primaryModel) {
          // Retry with the primary agent's model
          return executeSubagent(
            type,
            config,
            primaryModel,
            userPrompt,
            baseURL,
            subagentId,
            true, // Mark as retry to prevent infinite loops
            signal,
            undefined, // existingAgentId
            undefined, // existingConversationId
            maxTurns,
            parentAgentIdOverride,
            transcriptPath,
          );
        }
      }

      const propagatedError = state.finalError?.trim();
      const fallbackError = stderr || `Subagent exited with code ${exitCode}`;

      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: propagatedError || fallbackError,
      };
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: state.finalResult,
        success: !state.finalError,
        error: state.finalError || undefined,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      };
    }

    // Return error if captured
    if (state.finalError) {
      debugWarn(
        "subagent",
        `Subagent ${subagentId} (agentId=${state.agentId}) exited with captured error: ${state.finalError}. ` +
          `exitCode=${exitCode}, stderr=${stderr.length} bytes`,
      );
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: state.finalError,
        totalTokens: state.resultStats?.totalTokens,
        stepCount: state.resultStats?.stepCount,
        durationMs: state.resultStats?.durationMs,
      };
    }

    // No result or error captured during streaming — this is unusual
    debugWarn(
      "subagent",
      `Subagent ${subagentId} (agentId=${state.agentId}) exited cleanly (exitCode=${exitCode}) ` +
        `but no result event was captured during streaming. ` +
        `stdout=${Buffer.concat(stdoutChunks).length} bytes, stderr=${stderr.length} bytes`,
    );

    // Fallback: parse from stdout
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    debugLog(
      "subagent",
      `Falling back to parseResultFromStdout for ${subagentId} (agentId=${state.agentId}). ` +
        `stdout=${stdout.length} bytes, stderr=${stderr.length} bytes, exitCode=${exitCode}`,
    );
    const result = parseResultFromStdout(stdout, state.agentId);
    if (!result.success) {
      debugWarn(
        "subagent",
        `parseResultFromStdout failed for ${subagentId}: ${result.error}. ` +
          `stdout first 500 chars: ${stdout.slice(0, 500)}`,
      );
    }
    return result;
  } catch (error) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: getErrorMessage(error),
    };
  }
}

/**
 * Get the base URL for constructing agent links
 */
function getBaseURL(): string {
  const settings = settingsManager.getSettings();

  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    "https://api.letta.com";

  // Convert API URL to web UI URL if using hosted service
  if (baseURL === "https://api.letta.com") {
    return "https://app.letta.com";
  }

  return baseURL;
}

/**
 * Build a system reminder prefix for deployed agents
 */
function buildDeploySystemReminder(
  senderAgentName: string,
  senderAgentId: string,
): string {
  return `${SYSTEM_REMINDER_OPEN}
This task is from "${senderAgentName}" (agent ID: ${senderAgentId}), which deployed you as a subagent inside the Letta Code CLI (docs.letta.com/letta-code).
You have access to local tools (Bash, Read, Write, Edit, etc.) in their codebase.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

export function recallPromptForBackend(backendMode?: BackendMode): string {
  return backendMode === "local"
    ? recallSubagentLocalPrompt
    : recallSubagentPrompt;
}

function buildForkSystemReminder(
  subagentType?: string,
  backendMode?: BackendMode,
): string {
  if (subagentType === "recall") {
    const recallPrompt = recallPromptForBackend(backendMode);
    return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent and do not share its tools.

**Your sole task is now to search previous conversation history and provide a report. Ignore any existing ongoing tasks.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

Your toolset is limited to Bash, Read, and TaskOutput. You cannot edit files, run skills, dispatch further tasks, or take any action beyond searching messages and returning a report.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.

${recallPrompt}
${SYSTEM_REMINDER_CLOSE}

`;
  }

  return `${SYSTEM_REMINDER_OPEN}
You have been forked from the primary conversational thread to run as an independent subagent. The fork only exists so you can see the parent agent's conversation trajectory in-context as reference — you are NOT the primary agent and do not share its full toolset.

**Your sole task is the one described in the user message below. Ignore any existing ongoing tasks from the inherited trajectory.** Do not attempt to continue, finish, or act on anything the primary agent was in the middle of doing.

You have a scoped toolset that may differ from the primary agent's. Stay within it; don't assume you have the primary's full tool access.

You CANNOT ask questions mid-execution — all instructions are provided upfront.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

/**
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "general-purpose")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 * @param signal - Optional abort signal for interruption handling
 * @param existingAgentId - Optional ID of an existing agent to deploy
 * @param existingConversationId - Optional conversation ID to resume
 * @param parentAgentId - Parent agent ID captured at the synchronous call
 *   site. Preferred over reading `getCurrentAgentId()` here because this
 *   function runs after several async yields and the in-process context
 *   may have drifted (e.g., the listener processing another agent's turn).
 */
export async function spawnSubagent(
  type: string,
  prompt: string,
  userModel: string | undefined,
  subagentId: string,
  signal?: AbortSignal,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
  forkedContext?: boolean,
  parentAgentId?: string,
  transcriptPath?: string,
  parentConversationId?: string,
): Promise<SubagentResult> {
  const allConfigs = await getAllSubagentConfigs();
  const config = allConfigs[type];

  if (!config) {
    return {
      agentId: "",
      report: "",
      success: false,
      error: `Unknown subagent type: ${type}`,
    };
  }

  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

  const activeBackend = getBackend();
  const backendMode: BackendMode = activeBackend.capabilities.localMemfs
    ? "local"
    : "api";
  // Resolve parent scope before model selection so local subagents inherit the
  // active conversation's model override, not just the agent default.
  let resolvedParentAgentId = parentAgentId;
  if (!resolvedParentAgentId) {
    try {
      resolvedParentAgentId = getCurrentAgentId();
    } catch {
      // Context unavailable — carry forward undefined.
    }
  }
  let resolvedParentConversationId = parentConversationId;
  if (!resolvedParentConversationId) {
    try {
      resolvedParentConversationId = getConversationId() ?? undefined;
    } catch {
      // Context unavailable — carry forward undefined.
    }
  }
  const { handle: parentModelHandle, agent: parentAgent } =
    await getPrimaryAgentModelHandle({
      agentId: resolvedParentAgentId,
      conversationId: resolvedParentConversationId,
    });
  const billingTier = await getCurrentBillingTier();

  // For existing agents, don't override model; for new agents, use provided or config default
  const model = isDeployingExisting
    ? null
    : await resolveSubagentModel({
        userModel,
        recommendedModel: config.recommendedModel,
        parentModelHandle,
        billingTier,
        subagentType: type,
        backendMode,
      });
  const baseURL = getBaseURL();

  // Build the prompt with system reminder for deployed agents
  let finalPrompt = prompt;
  if (isDeployingExisting && resolvedParentAgentId) {
    try {
      const cachedParent =
        parentAgent ??
        (await getBackend().retrieveAgent(resolvedParentAgentId));
      if (forkedContext) {
        const systemReminder = buildForkSystemReminder(type, backendMode);
        finalPrompt = systemReminder + prompt;
      } else {
        const systemReminder = buildDeploySystemReminder(
          cachedParent.name ?? "",
          resolvedParentAgentId,
        );
        finalPrompt = systemReminder + prompt;
      }
    } catch {
      // If we can't get parent agent info, proceed without the reminder
    }
  }

  // Fork subagents (e.g. recall) deploy the parent agent into a forked
  // conversation. They don't emit an init event carrying agent_id/
  // conversation_id (which is the usual source of agentURL), so without this
  // the card would have no link and any fallback would route to the parent's
  // main conversation. Set the link eagerly to the forked conversation so it
  // opens the subagent's own thread instead.
  if (forkedContext && existingAgentId && existingConversationId) {
    const forkAgentURL = buildAgentReference(existingAgentId, {
      conversationId: existingConversationId,
    });
    updateSubagent(subagentId, { agentURL: forkAgentURL });
  }

  // Execute subagent - state updates are handled via the state store
  const result = await executeSubagent(
    type,
    config,
    model,
    finalPrompt,
    baseURL,
    subagentId,
    false,
    signal,
    existingAgentId,
    existingConversationId,
    maxTurns,
    resolvedParentAgentId,
    transcriptPath,
  );

  return result;
}
