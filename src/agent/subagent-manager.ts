/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Creating separate Letta agent instances for each subagent type
 * - Passing conversation history to subagents
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 */

import type {
  AgentState,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import { getErrorMessage } from "../utils/error";
import { getClient } from "./client";
import { type SubagentConfig, getAllSubagentConfigs } from "./subagents";

// ============================================================================
// Constants
// ============================================================================

/** ANSI escape codes for console output */
const ANSI_DIM = "\x1b[2m";
const ANSI_RESET = "\x1b[0m";

/** Maximum number of messages to fetch for conversation history */
const CONVERSATION_HISTORY_LIMIT = 100;

/** Default embedding model for subagents */
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";

/** Base Letta tools that are always kept regardless of allowedTools config */
const BASE_LETTA_TOOLS = ["memory", "web_search", "conversation_search", "fetch_webpage"];

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
 * Resolve model string to full model identifier
 * Uses the model resolution utilities from model.ts
 */
async function resolveSubagentModel(
  modelShorthand: string | undefined,
  config: SubagentConfig,
): Promise<string> {
  // Import dynamically to avoid circular dependencies
  const { resolveModel } = await import("./model");

  // If user provided a model, try to resolve it
  if (modelShorthand) {
    const resolved = resolveModel(modelShorthand);
    if (resolved) {
      return resolved;
    }
    console.warn(
      `Failed to resolve model "${modelShorthand}", falling back to recommended model`,
    );
  }

  // Fall back to recommended model from config, and resolve it
  const resolved = resolveModel(config.recommendedModel);
  if (!resolved) {
    throw new Error(
      `Failed to resolve recommended model "${config.recommendedModel}" for subagent`,
    );
  }

  return resolved;
}

/**
 * Extract conversation history from main agent
 */
async function getConversationHistory(
  agentId: string,
): Promise<MessageCreate[]> {
  const client = await getClient();

  // Get the agent's message history
  const messagesPage = await client.agents.messages.list(agentId, {
    limit: CONVERSATION_HISTORY_LIMIT,
  });
  const messages = messagesPage.items;

  // Convert message history to MessageCreate format for sending to new agent
  const history: MessageCreate[] = [];

  for (const msg of messages) {
    if (msg.message_type === "user_message") {
      history.push({
        role: "user" as const,
        content: msg.content || "",
      });
    } else if (msg.message_type === "assistant_message") {
      history.push({
        role: "assistant" as const,
        content: msg.content || "",
      });
    } else if (msg.message_type === "system_message") {
      history.push({
        role: "system" as const,
        content: msg.content || "",
      });
    }
  }

  return history;
}

/**
 * Create a subagent with specified configuration
 * Uses dynamic import to reuse createAgent while avoiding circular dependencies
 */
async function createSubagent(
  type: string,
  config: SubagentConfig,
  model: string,
  userPrompt: string,
): Promise<AgentState> {
  // Inject user prompt into system prompt
  const systemPrompt = config.systemPrompt.replace(
    "{user_provided_prompt}",
    userPrompt,
  );

  // Use dynamic import to break circular dependency at module initialization time
  const { createAgent } = await import("./create");

  const client = await getClient();

  // Create agent using the standard createAgent function with custom system prompt
  const agent = await createAgent(
    `subagent-${type}-${Date.now()}`,
    model,
    DEFAULT_EMBEDDING_MODEL,
    undefined, // no update args
    false, // share memory blocks with parent agent
    undefined, // no skills directory
    true, // parallel tool calls
    false, // no sleeptime
    systemPrompt, // custom system prompt for this subagent type
  );

  // Handle tool filtering
  const allTools = agent.tools || [];

  // If allowedTools is "all", keep all tools
  if (config.allowedTools === "all") {
    return agent;
  }

  // Filter to keep only allowed tools (and base tools like memory, web_search, etc.)
  const allowedToolNames = new Set(config.allowedTools);
  const remainingTools = allTools.filter((tool) => {
    if (!tool.name) return true; // Keep tools without names (shouldn't happen)
    // Keep if it's an allowed tool OR a base Letta tool
    return (
      allowedToolNames.has(tool.name as never) ||
      BASE_LETTA_TOOLS.includes(tool.name)
    );
  });

  // Extract tool IDs from remaining tools
  const remainingToolIds = remainingTools
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string");

  // Update agent with filtered tools
  if (remainingToolIds.length !== allTools.length) {
    await client.agents.update(agent.id, {
      tool_ids: remainingToolIds,
    });
  }

  return agent;
}

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 */
async function executeSubagent(
  agent: AgentState,
  conversationHistory: MessageCreate[],
  userPrompt: string,
): Promise<SubagentResult> {
  try {
    // First, send conversation history to the subagent
    const { sendMessageStream } = await import("./message");

    const stream = await sendMessageStream(agent.id, conversationHistory);

    // Drain the stream (just need to populate the agent's message history)
    for await (const _chunk of stream) {
      // No-op, just consuming the stream to populate history
    }

    // Now run letta in headless mode with the user prompt
    // This reuses ALL the existing headless logic (tool execution, approvals, etc.)
    const { spawn } = await import("node:child_process");
    const { createInterface } = await import("node:readline");

    // Spawn letta in headless mode with stream-json output for progress visibility
    const proc = spawn(
      "letta",
      ["--agent", agent.id, "-p", userPrompt, "--output-format", "stream-json"],
      {
        env: process.env,
      }
    );

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

            console.log(`${ANSI_DIM}     ⎿  Done (${toolCount} tool use${toolCount !== 1 ? "s" : ""} · ${tokenStr} tokens · ${durationStr})${ANSI_RESET}`);
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
      proc.on("close", (code) => {
        resolve(code);
      });
      proc.on("error", () => resolve(null));
    });

    const stderr = Buffer.concat(stderrChunks).toString("utf-8");

    // Check for errors
    if (exitCode !== 0) {
      return {
        agentId: agent.id,
        report: "",
        success: false,
        error: `Subagent execution failed with exit code ${exitCode}: ${stderr}`,
      };
    }

    // Use the captured final result, or parse from stdout if not captured
    if (finalResult !== null) {
      return {
        agentId: agent.id,
        report: finalResult,
        success: !finalError,
        error: finalError || undefined,
      };
    }

    // If we captured an error but no result
    if (finalError) {
      return {
        agentId: agent.id,
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
          agentId: agent.id,
          report: result.result || "",
          success: !result.is_error,
          error: result.is_error ? (result.result || "Unknown error") : undefined,
        };
      }

      // Unexpected format
      return {
        agentId: agent.id,
        report: "",
        success: false,
        error: "Unexpected output format from subagent",
      };
    } catch (parseError) {
      return {
        agentId: agent.id,
        report: "",
        success: false,
        error: `Failed to parse subagent output: ${getErrorMessage(parseError)}`,
      };
    }
  } catch (error) {
    return {
      agentId: agent.id,
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
 */
export async function spawnSubagent(
  mainAgentId: string,
  type: string,
  prompt: string,
  description: string,
  model?: string,
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

  const resolvedModel = await resolveSubagentModel(model, config);

  // Get conversation history from main agent
  const conversationHistory = await getConversationHistory(mainAgentId);

  // Create subagent with appropriate configuration
  const subagent = await createSubagent(type, config, resolvedModel, prompt);

  // Build and print header lines
  const baseURL = await getBaseURL();
  const agentURL = `${baseURL}/agents/${subagent.id}`;

  // Print subagent header before execution starts
  console.log(`${ANSI_DIM}✻ ${type}(${description})${ANSI_RESET}`);
  console.log(`${ANSI_DIM}  ⎿  Subagent: ${agentURL}${ANSI_RESET}`);

  // Execute subagent and collect final report
  const result = await executeSubagent(subagent, conversationHistory, prompt);

  // Clean up subagent after execution
  try {
    const client = await getClient();
    await client.agents.delete(subagent.id);
  } catch {
    // Silently ignore cleanup errors
  }

  return result;
}
