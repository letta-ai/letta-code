/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Spawning subagents via letta CLI in headless mode
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import { getErrorMessage } from "../utils/error";
import { type SubagentConfig, getAllSubagentConfigs } from "./subagents";

// ============================================================================
// Constants
// ============================================================================

/** ANSI escape codes for console output */
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

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
 * Build CLI arguments for spawning a subagent
 */
async function buildSubagentArgs(
  type: string,
  config: SubagentConfig,
  model: string,
  userPrompt: string,
): Promise<string[]> {
  const args: string[] = [
    "--new",
    "--fresh-blocks",
    "--system", type,
    "--model", model,
    "-p", userPrompt,
    "--output-format", "stream-json",
  ];

  // Inherit permission mode from parent
  const { permissionMode } = await import("../permissions/mode");
  const currentMode = permissionMode.getMode();
  if (currentMode !== "default") {
    args.push("--permission-mode", currentMode);
  }

  // Add memory block filtering if specified
  if (config.memoryBlocks === "none") {
    args.push("--init-blocks", "none");
  } else if (Array.isArray(config.memoryBlocks) && config.memoryBlocks.length > 0) {
    args.push("--init-blocks", config.memoryBlocks.join(","));
  }
  // If "all", don't add --init-blocks (default behavior)

  // Add tool filtering if specified
  if (config.allowedTools !== "all" && Array.isArray(config.allowedTools) && config.allowedTools.length > 0) {
    args.push("--allowedTools", config.allowedTools.join(","));
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
    // Run letta in headless mode with the user prompt
    // This reuses ALL the existing headless logic (tool execution, approvals, etc.)
    const { spawn } = await import("node:child_process");
    const { createInterface } = await import("node:readline");

    // Build CLI arguments
    const cliArgs = await buildSubagentArgs(type, config, model, userPrompt);

    // Spawn letta in headless mode with stream-json output for progress visibility
    const proc = spawn("letta", cliArgs, {
      cwd: process.cwd(),
      env: process.env,
    });

    // Track all stdout for final result parsing
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Create readline interface to parse JSON events line by line
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Number.POSITIVE_INFINITY,
    });

    // Track tool calls for display (by tool_call_id to avoid duplicates)
    const displayedToolCalls = new Set<string>();
    // Accumulate tool call info from message chunks (name + args may come separately)
    const pendingToolCalls = new Map<string, { name: string; args: string }>();
    let agentId: string | null = null;
    let finalResult: string | null = null;
    let finalError: string | null = null;
    let resultStats: { durationMs: number; totalTokens: number } | null = null;

    // Helper to format tool arguments for display
    function formatToolArgs(argsStr: string): string {
      try {
        const args = JSON.parse(argsStr);
        // Show only the most important arguments, limit length
        const entries = Object.entries(args)
          .filter(([_, value]) => value !== undefined && value !== null)
          .slice(0, 2); // Show max 2 args

        if (entries.length === 0) return "";

        return entries
          .map(([key, value]) => {
            let displayValue = String(value);
            if (displayValue.length > 100) {
              displayValue = displayValue.slice(0, 97) + "...";
            }
            return `${key}: "${displayValue}"`;
          })
          .join(", ");
      } catch {
        return "";
      }
    }

    // Helper to display a tool call live
    function displayToolCall(toolCallId: string, toolName: string, toolArgs: string) {
      if (!toolCallId || !toolName || displayedToolCalls.has(toolCallId)) return;
      displayedToolCalls.add(toolCallId);

      const formattedArgs = formatToolArgs(toolArgs);
      if (formattedArgs) {
        console.log(`${ANSI_DIM}     ${toolName}(${formattedArgs})${ANSI_RESET}`);
      } else {
        console.log(`${ANSI_DIM}     ${toolName}()${ANSI_RESET}`);
      }
    }

    // Parse each line as a JSON event
    rl.on("line", (line: string) => {
      // Collect for final parsing
      stdoutChunks.push(Buffer.from(line + "\n"));

      try {
        const event = JSON.parse(line);

        // Capture agent ID from init event and print URL immediately
        if (event.type === "init" && event.agent_id) {
          agentId = event.agent_id;
          const agentURL = `${baseURL}/agents/${agentId}`;
          console.log(`${ANSI_DIM}  ⎿  Subagent: ${agentURL}${ANSI_RESET}`);
        }

        // Track tool calls from message chunks (handles streamed tool calls)
        if (event.type === "message" && event.message_type === "approval_request_message") {
          const toolCalls = Array.isArray(event.tool_calls)
            ? event.tool_calls
            : event.tool_call
              ? [event.tool_call]
              : [];

          for (const toolCall of toolCalls) {
            const id = toolCall.tool_call_id;
            if (!id) continue;

            // Accumulate name and args (they may come in separate chunks)
            const prev = pendingToolCalls.get(id) || { name: "", args: "" };
            const name = toolCall.name || prev.name;
            const args = prev.args + (toolCall.arguments || "");
            pendingToolCalls.set(id, { name, args });
          }
        }

        // Display tool calls live from auto_approval events (has complete name + args)
        if (event.type === "auto_approval") {
          const toolCallId = event.tool_call_id;
          const toolName = event.tool_name;
          const toolArgs = event.tool_args || "{}";
          displayToolCall(toolCallId, toolName, toolArgs);
        }

        // Capture final result and stats
        if (event.type === "result") {
          finalResult = event.result || "";
          resultStats = {
            durationMs: event.duration_ms || 0,
            totalTokens: event.usage?.total_tokens || 0,
          };

          // Check if result indicates an error
          if (event.is_error) {
            finalError = event.result || "Unknown error";
          } else {
            // Display any pending tool calls that weren't auto-approved
            for (const [id, { name, args }] of pendingToolCalls.entries()) {
              if (name && !displayedToolCalls.has(id)) {
                displayToolCall(id, name, args || "{}");
              }
            }

            // Display completion stats
            const toolCount = displayedToolCalls.size;
            const tokenStr = resultStats.totalTokens >= 1000
              ? `${(resultStats.totalTokens / 1000).toFixed(1)}k`
              : String(resultStats.totalTokens);
            const durationSec = resultStats.durationMs / 1000;
            const durationStr = durationSec >= 60
              ? `${Math.floor(durationSec / 60)}m ${Math.round(durationSec % 60)}s`
              : `${durationSec.toFixed(1)}s`;

            console.log(`${ANSI_DIM}      ⎿  Done (${toolCount} tool use${toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens · ${durationStr})${ANSI_RESET}`);
          }
        }

        // Handle error events
        if (event.type === "error") {
          finalError = event.error || event.message || "Unknown error";
        }
      } catch {
        // Not valid JSON, ignore
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

    const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();

    // Check for errors
    if (exitCode !== 0) {
      // Extract meaningful error message from stderr
      // stderr often starts with "Error: " which we can use directly
      const errorMessage = stderr || `Subagent exited with code ${exitCode}`;
      return {
        agentId: agentId || "",
        report: "",
        success: false,
        error: errorMessage,
      };
    }

    // Use the captured final result, or parse from stdout if not captured
    if (finalResult !== null) {
      return {
        agentId: agentId || "",
        report: finalResult,
        success: !finalError,
        error: finalError || undefined,
      };
    }

    // If we captured an error but no result
    if (finalError) {
      return {
        agentId: agentId || "",
        report: "",
        success: false,
        error: finalError,
      };
    }

    // Fallback: parse the last JSON line for result
    const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
    const lines = stdout.trim().split("\n");
    const lastLine = lines[lines.length - 1] ?? "";

    try {
      const result = JSON.parse(lastLine);

      if (result.type === "result") {
        return {
          agentId: agentId || "",
          report: result.result || "",
          success: !result.is_error,
          error: result.is_error ? (result.result || "Unknown error") : undefined,
        };
      }

      // Unexpected format
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
async function getBaseURL(): Promise<string> {
  const { settingsManager } = await import("../settings-manager");
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
  // Get all configs (built-in + custom)
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

  // Use parent agent's model override, or fall back to subagent config's recommended model
  const model = userModel || config.recommendedModel;

  // Get base URL for agent links before starting
  const baseURL = await getBaseURL();

  // Print subagent header before execution starts
  console.log(`${ANSI_DIM}✻ ${type}(${description})${ANSI_RESET}`);

  // Execute subagent via letta CLI in headless mode
  // The CLI will create the agent and execute it
  // URL is printed immediately when we get the agent ID from the init event
  const result = await executeSubagent(type, config, model, prompt, baseURL);

  // Print error to console so user can see it
  if (!result.success && result.error) {
    console.log(`${ANSI_DIM}      ⎿  Error: ${result.error}${ANSI_RESET}`);
  }

  return result;
}
