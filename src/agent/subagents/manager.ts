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
import { cliPermissions } from "../../permissions/cli";
import { permissionMode } from "../../permissions/mode";
import { sessionPermissions } from "../../permissions/session";
import { settingsManager } from "../../settings-manager";
import { getErrorMessage } from "../../utils/error";
import { getClient } from "../client";
import { getCurrentAgentId } from "../context";
import { getAllSubagentConfigs, type SubagentConfig } from ".";

// ============================================================================
// Types
// ============================================================================

/**
 * Subagent execution result
 */
export interface SubagentResult {
  agentId: string;
  report: string;
  success: boolean;
  error?: string;
}

/**
 * State tracked during subagent execution
 */
interface ExecutionState {
  agentId: string | null;
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
 * Get the primary agent's model handle
 * Falls back to default if unable to fetch
 */
async function getPrimaryAgentModel(): Promise<string | null> {
  try {
    const agentId = getCurrentAgentId();
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    const endpointType = agent.llm_config?.model_endpoint_type;
    const model = agent.llm_config?.model;
    if (endpointType && model) {
      return `${endpointType}/${model}`;
    }
    return null;
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
  event: { agent_id?: string },
  state: ExecutionState,
  baseURL: string,
  subagentId: string,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = `${baseURL}/agents/${event.agent_id}`;
    updateSubagent(subagentId, { agentURL });
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
  event: { tool_call_id?: string; tool_name?: string; tool_args?: string },
  state: ExecutionState,
  subagentId: string,
): void {
  const { tool_call_id, tool_name, tool_args = "{}" } = event;
  if (tool_call_id && tool_name) {
    recordToolCall(
      subagentId,
      tool_call_id,
      tool_name,
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
        handleInitEvent(event, state, baseURL, subagentId);
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
  model: string,
  userPrompt: string,
): string[] {
  const args: string[] = [
    "--new",
    "--system",
    type,
    "--model",
    model,
    "-p",
    userPrompt,
    "--output-format",
    "stream-json",
  ];

  // Inherit permission mode from parent
  const currentMode = permissionMode.getMode();
  if (currentMode !== "default") {
    args.push("--permission-mode", currentMode);
  }

  // Inherit permission rules from parent (CLI + session rules)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  const sessionAllowRules = sessionPermissions.getRules().allow || [];
  const combinedAllowedTools = [
    ...new Set([...parentAllowedTools, ...sessionAllowRules]),
  ];
  if (combinedAllowedTools.length > 0) {
    args.push("--allowedTools", combinedAllowedTools.join(","));
  }
  const parentDisallowedTools = cliPermissions.getDisallowedTools();
  if (parentDisallowedTools.length > 0) {
    args.push("--disallowedTools", parentDisallowedTools.join(","));
  }

  // Add memory block filtering if specified
  if (config.memoryBlocks === "none") {
    args.push("--init-blocks", "none");
  } else if (
    Array.isArray(config.memoryBlocks) &&
    config.memoryBlocks.length > 0
  ) {
    args.push("--init-blocks", config.memoryBlocks.join(","));
  }

  // Add tool filtering if specified
  if (
    config.allowedTools !== "all" &&
    Array.isArray(config.allowedTools) &&
    config.allowedTools.length > 0
  ) {
    args.push("--tools", config.allowedTools.join(","));
  }

  return args;
}

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 */
async function executeSubagent(
  type: string,
  config: SubagentConfig,
  model: string,
  userPrompt: string,
  baseURL: string,
  subagentId: string,
  isRetry = false,
): Promise<SubagentResult> {
  try {
    const cliArgs = buildSubagentArgs(type, config, model, userPrompt);

    // Spawn letta in headless mode with stream-json output
    const proc = spawn("letta", cliArgs, {
      cwd: process.cwd(),
      env: process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Initialize execution state
    const state: ExecutionState = {
      agentId: null,
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

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Handle non-zero exit code
    if (exitCode !== 0) {
      // Check if this is a provider-not-supported error and we haven't retried yet
      if (!isRetry && isProviderNotSupportedError(stderr)) {
        const primaryModel = await getPrimaryAgentModel();
        if (primaryModel && primaryModel !== model) {
          console.warn(
            `Subagent model "${model}" uses unsupported provider, falling back to primary agent's model`,
          );

          // Retry with the primary agent's model
          return executeSubagent(
            type,
            config,
            primaryModel,
            userPrompt,
            baseURL,
            subagentId,
            true, // Mark as retry to prevent infinite loops
          );
        }
      }

      return {
        agentId: state.agentId || "",
        report: "",
        success: false,
        error: stderr || `Subagent exited with code ${exitCode}`,
      };
    }

    // Return captured result if available
    if (state.finalResult !== null) {
      return {
        agentId: state.agentId || "",
        report: state.finalResult,
        success: !state.finalError,
        error: state.finalError || undefined,
      };
    }

    // Return error if captured
    if (state.finalError) {
      return {
        agentId: state.agentId || "",
        report: "",
        success: false,
        error: state.finalError,
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
 * Spawn a subagent and execute it autonomously
 *
 * @param type - Subagent type (e.g., "code-reviewer", "explore")
 * @param prompt - The task prompt for the subagent
 * @param userModel - Optional model override from the parent agent
 * @param subagentId - ID for tracking in the state store (registered by Task tool)
 */
export async function spawnSubagent(
  type: string,
  prompt: string,
  userModel: string | undefined,
  subagentId: string,
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

  const model = userModel || config.recommendedModel;
  const baseURL = getBaseURL();

  // Execute subagent - state updates are handled via the state store
  const result = await executeSubagent(
    type,
    config,
    model,
    prompt,
    baseURL,
    subagentId,
  );

  return result;
}
