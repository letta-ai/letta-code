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
import { cliPermissions } from "../../permissions/cli";
import { permissionMode } from "../../permissions/mode";
import { settingsManager } from "../../settings-manager";
import { getErrorMessage } from "../../utils/error";
import { getAllSubagentConfigs, type SubagentConfig } from ".";

// ============================================================================
// Constants
// ============================================================================

/** ANSI escape codes for console output */
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

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
 * Format tool arguments for display (truncated)
 */
function formatToolArgs(argsStr: string): string {
  try {
    const args = JSON.parse(argsStr);
    const entries = Object.entries(args)
      .filter(([_, value]) => value !== undefined && value !== null)
      .slice(0, 2); // Show max 2 args

    if (entries.length === 0) return "";

    return entries
      .map(([key, value]) => {
        let displayValue = String(value);
        if (displayValue.length > 100) {
          displayValue = `${displayValue.slice(0, 97)}...`;
        }
        return `${key}: "${displayValue}"`;
      })
      .join(", ");
  } catch {
    return "";
  }
}

/**
 * Display a tool call to the console
 */
function displayToolCall(
  toolCallId: string,
  toolName: string,
  toolArgs: string,
  displayedToolCalls: Set<string>,
): void {
  if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
  displayedToolCalls.add(toolCallId);

  const formattedArgs = formatToolArgs(toolArgs);
  if (formattedArgs) {
    console.log(`${ANSI_DIM}     ${toolName}(${formattedArgs})${ANSI_RESET}`);
  } else {
    console.log(`${ANSI_DIM}     ${toolName}()${ANSI_RESET}`);
  }
}

/**
 * Format completion stats for display
 */
function formatCompletionStats(
  toolCount: number,
  totalTokens: number,
  durationMs: number,
): string {
  const tokenStr =
    totalTokens >= 1000
      ? `${(totalTokens / 1000).toFixed(1)}k`
      : String(totalTokens);

  const durationSec = durationMs / 1000;
  const durationStr =
    durationSec >= 60
      ? `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`
      : `${durationSec.toFixed(1)}s`;

  return `${toolCount} tool use${toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens · ${durationStr}`;
}

/**
 * Handle an init event from the subagent stream
 */
function handleInitEvent(
  event: { agent_id?: string },
  state: ExecutionState,
  baseURL: string,
): void {
  if (event.agent_id) {
    state.agentId = event.agent_id;
    const agentURL = `${baseURL}/agents/${event.agent_id}`;
    console.log(`${ANSI_DIM}  ⎿  Subagent: ${agentURL}${ANSI_RESET}`);
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
): void {
  const { tool_call_id, tool_name, tool_args = "{}" } = event;
  if (tool_call_id && tool_name) {
    displayToolCall(
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
): void {
  state.finalResult = event.result || "";
  state.resultStats = {
    durationMs: event.duration_ms || 0,
    totalTokens: event.usage?.total_tokens || 0,
  };

  if (event.is_error) {
    state.finalError = event.result || "Unknown error";
  } else {
    // Display any pending tool calls that weren't auto-approved
    for (const [id, { name, args }] of state.pendingToolCalls.entries()) {
      if (name && !state.displayedToolCalls.has(id)) {
        displayToolCall(id, name, args || "{}", state.displayedToolCalls);
      }
    }

    // Display completion stats
    const statsStr = formatCompletionStats(
      state.displayedToolCalls.size,
      state.resultStats.totalTokens,
      state.resultStats.durationMs,
    );
    console.log(`${ANSI_DIM}      ⎿  Done (${statsStr})${ANSI_RESET}`);
  }
}

/**
 * Process a single JSON event from the subagent stream
 */
function processStreamEvent(
  line: string,
  state: ExecutionState,
  baseURL: string,
): void {
  try {
    const event = JSON.parse(line);

    switch (event.type) {
      case "init":
        handleInitEvent(event, state, baseURL);
        break;

      case "message":
        if (event.message_type === "approval_request_message") {
          handleApprovalRequestEvent(event, state);
        }
        break;

      case "auto_approval":
        handleAutoApprovalEvent(event, state);
        break;

      case "result":
        handleResultEvent(event, state);
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

  // Inherit permission rules from parent (--allowedTools/--disallowedTools)
  const parentAllowedTools = cliPermissions.getAllowedTools();
  if (parentAllowedTools.length > 0) {
    args.push("--allowedTools", parentAllowedTools.join(","));
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
      processStreamEvent(line, state, baseURL);
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
 * @param description - Short description for display
 * @param userModel - Optional model override from the parent agent
 */
export async function spawnSubagent(
  type: string,
  prompt: string,
  description: string,
  userModel?: string,
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

  // Print subagent header before execution starts
  console.log(`${ANSI_DIM}✻ ${type}(${description})${ANSI_RESET}`);

  const result = await executeSubagent(type, config, model, prompt, baseURL);

  if (!result.success && result.error) {
    console.log(`${ANSI_DIM}      ⎿  Error: ${result.error}${ANSI_RESET}`);
  }

  return result;
}
