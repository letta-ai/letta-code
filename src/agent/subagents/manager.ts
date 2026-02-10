/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import {
  addToolCall,
  updateSubagent,
} from "../../cli/helpers/subagentState.js";
import {
  INTERRUPTED_BY_USER,
  SYSTEM_REMINDER_CLOSE,
  SYSTEM_REMINDER_OPEN,
} from "../../constants";
import { cliPermissions } from "../../permissions/cli";
import { permissionMode } from "../../permissions/mode";
import { sessionPermissions } from "../../permissions/session";
import { settingsManager } from "../../settings-manager";

import { getErrorMessage } from "../../utils/error";
import { getAvailableModelHandles } from "../available-models";
import { getClient } from "../client";
import { getCurrentAgentId } from "../context";
import { resolveModel } from "../model";

import { getAllSubagentConfigs, type SubagentConfig } from ".";

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
}

/**
 * State tracked during subagent execution
 */
interface ExecutionState {
  agentId: string | null;
  conversationId: string | null;
  finalResult: string | null;
  finalError: string | null;
  resultStats: { durationMs: number; totalTokens: number } | null;
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
function getModelHandleFromAgent(agent: {
  llm_config?: { model_endpoint_type?: string | null; model?: string | null };
}): string | null {
  const endpoint = agent.llm_config?.model_endpoint_type;
  const model = agent.llm_config?.model;
  if (endpoint && model) {
    return `${endpoint}/${model}`;
  }
  return model || null;
}

async function getPrimaryAgentModelHandle(): Promise<string | null> {
  try {
    const agentId = getCurrentAgentId();
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    return getModelHandleFromAgent(agent);
  } catch {
    return null;
  }
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

export async function resolveSubagentModel(options: {
  userModel?: string;
  recommendedModel?: string;
  parentModelHandle?: string | null;
  availableHandles?: Set<string>;
}): Promise<string | null> {
  const { userModel, recommendedModel, parentModelHandle } = options;

  if (userModel) return userModel;

  let recommendedHandle: string | null = null;
  if (recommendedModel && recommendedModel !== "inherit") {
    recommendedHandle = resolveModel(recommendedModel);
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
  event: {
    agent_id?: string;
    conversation_id?: string;
    reasoning_effort?: string | null;
  },
  state: ExecutionState,
  baseURL: string,
  subagentId: string,
): void {
  const next: Parameters<typeof updateSubagent>[1] = {};

  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = `${baseURL}/agents/${event.agent_id}`;
    next.agentURL = agentURL;
  }

  if (
    typeof event.reasoning_effort === "string" ||
    event.reasoning_effort === null
  ) {
    next.reasoningEffort = event.reasoning_effort;
  }

  if (Object.keys(next).length > 0) {
    updateSubagent(subagentId, next);
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
    usage?: { total_tokens?: number };
  },
  state: ExecutionState,
  subagentId: string,
): void {
  state.finalResult = event.result || "";
  state.resultStats = {
    durationMs: event.duration_ms || 0,
    totalTokens: event.usage?.total_tokens || 0,
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
  baseURL: string,
  subagentId: string,
): void {
  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case "init":
      case "system":
        // Handle both legacy "init" type and new "system" type with subtype "init"
        if (event.type === "init" || event.subtype === "init") {
          handleInitEvent(event, state, baseURL, subagentId);
        }
        break;

      case "message":
        if (event.message_type === "approval_request_message") {
          handleApprovalRequestEvent(event, state);
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

  try {
    const result = JSON.parse(lastLine);

    if (result.type === "result") {
      return {
        agentId: agentId || "",
        report: result.result || "",
        success: !result.is_error,
        error: result.is_error ? result.result || "Unknown error" : undefined,
      };
    }

    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: "Unexpected output format from subagent",
    };
  } catch (parseError) {
    return {
      agentId: agentId || "",
      report: "",
      success: false,
      error: `Failed to parse subagent output: ${getErrorMessage(parseError)}`,
    };
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Build CLI arguments for spawning a subagent
 */
function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string | null,
  userPrompt: string,
  existingAgentId?: string,
  existingConversationId?: string,
  maxTurns?: number,
): string[] {
  const args: string[] = [];
  const isDeployingExisting = Boolean(
    existingAgentId || existingConversationId,
  );

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
    if (model) {
      args.push("--model", model);
    }
  }

  args.push("-p", userPrompt);
  args.push("--output-format", "stream-json");

  // Use subagent's configured permission mode, or inherit from parent
  const subagentMode = config.permissionMode;
  const parentMode = permissionMode.getMode();
  const modeToUse = subagentMode || parentMode;
  if (modeToUse !== "default") {
    args.push("--permission-mode", modeToUse);
  }

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

  // Add memory block filtering if specified (only for new agents)
  if (!isDeployingExisting) {
    if (config.memoryBlocks === "none") {
      args.push("--init-blocks", "none");
    } else if (
      Array.isArray(config.memoryBlocks) &&
      config.memoryBlocks.length > 0
    ) {
      args.push("--init-blocks", config.memoryBlocks.join(","));
    }
  }

  // Add tool filtering if specified (applies to both new and existing agents)
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    args.push("--tools", config.allowedTools.join(","));
  }

  // Add max turns limit if specified
  if (maxTurns !== undefined && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
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
    const cliArgs = buildSubagentArgs(
      type,
      config,
      model,
      userPrompt,
      existingAgentId,
      existingConversationId,
      maxTurns,
    );

    // Spawn Letta Code in headless mode.
    // Use the same binary as the current process, with fallbacks:
    // 1. LETTA_CODE_BIN env var (explicit override)
    // 2. Current process argv[1] if it's a .js file (built letta.js)
    // 3. ./letta.js if running from dev (src/index.ts)
    // 4. "letta" (global install)
    const currentScript = process.argv[1] || "";
    const lettaCmd =
      process.env.LETTA_CODE_BIN ||
      (currentScript.endsWith(".js") ? currentScript : null) ||
      (currentScript.includes("src/index.ts") ? "./letta.js" : null) ||
      "letta";
    // Pass parent agent ID so subagents can access parent's context (e.g., search history)
    let parentAgentId: string | undefined;
    try {
      parentAgentId = getCurrentAgentId();
    } catch {
      // Context not available
    }

    // Resolve auth once in parent and forward to child to avoid per-subagent
    // keychain lookups under high parallel fan-out.
    const settings = await settingsManager.getSettingsWithSecureTokens();
    const inheritedApiKey =
      process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;
    const inheritedBaseUrl =
      process.env.LETTA_BASE_URL || settings.env?.LETTA_BASE_URL;

    const proc = spawn(lettaCmd, cliArgs, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ...(inheritedApiKey && { LETTA_API_KEY: inheritedApiKey }),
        ...(inheritedBaseUrl && { LETTA_BASE_URL: inheritedBaseUrl }),
        // Tag Task-spawned agents for easy filtering.
        LETTA_CODE_AGENT_ROLE: "subagent",
        // Pass parent agent ID for subagents that need to access parent's context
        ...(parentAgentId && { LETTA_PARENT_AGENT_ID: parentAgentId }),
      },
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

    // Create readline interface to parse JSON events line by line
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    rl.on("line", (line: string) => {
      stdoutChunks.push(Buffer.from(`${line}\n`));
      processStreamEvent(line, state, baseURL, subagentId);
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderrChunks.push(data);
    });

    // Wait for process to complete
    const exitCode = await new Promise<number | null>((resolve) => {
      proc.on("close", resolve);
      proc.on("error", () => resolve(null));
    });

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
        const primaryModel = await getPrimaryAgentModelHandle();
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
      };
    }

    // Return error if captured
    if (state.finalError) {
      return {
        agentId: state.agentId || "",
        conversationId: state.conversationId || undefined,
        report: "",
        success: false,
        error: state.finalError,
        totalTokens: state.resultStats?.totalTokens,
      };
    }

    // Fallback: parse from stdout
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    return parseResultFromStdout(stdout, state.agentId);
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
  subagentType: string,
): string {
  const toolDescription =
    subagentType === "explore"
      ? "read-only tools (Read, Glob, Grep)"
      : "local tools (Bash, Read, Write, Edit, etc.)";

  return `${SYSTEM_REMINDER_OPEN}
This task is from "${senderAgentName}" (agent ID: ${senderAgentId}), which deployed you as a subagent inside the Letta Code CLI (docs.letta.com/letta-code).
You have access to ${toolDescription} in their codebase.
Your final message will be returned to the caller.
${SYSTEM_REMINDER_CLOSE}

`;
}

/**
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "explore")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 * @param signal - Optional abort signal for interruption handling
 * @param existingAgentId - Optional ID of an existing agent to deploy
 * @param existingConversationId - Optional conversation ID to resume
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

  const parentModelHandle = await getPrimaryAgentModelHandle();

  // For existing agents, don't override model; for new agents, use provided or config default
  const model = isDeployingExisting
    ? null
    : await resolveSubagentModel({
        userModel,
        recommendedModel: config.recommendedModel,
        parentModelHandle,
      });
  const baseURL = getBaseURL();

  // Build the prompt with system reminder for deployed agents
  let finalPrompt = prompt;
  if (isDeployingExisting) {
    try {
      const parentAgentId = getCurrentAgentId();
      const client = await getClient();
      const parentAgent = await client.agents.retrieve(parentAgentId);
      const systemReminder = buildDeploySystemReminder(
        parentAgent.name,
        parentAgentId,
        type,
      );
      finalPrompt = systemReminder + prompt;
    } catch {
      // If we can't get parent agent info, proceed without the reminder
    }
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
  );

  return result;
}
