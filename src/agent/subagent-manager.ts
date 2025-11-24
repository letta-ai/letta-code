/**
 * Subagent manager for spawning and coordinating subagents
 *
 * This module handles:
 * - Creating separate Letta agent instances for each subagent type
 * - Passing conversation history to subagents
 * - Executing subagents and collecting final reports
 * - Managing parallel subagent execution
 * - Tracking subagent state for resume functionality
 */

import type {
  AgentResponse,
  AgentType,
  MessageCreate,
} from "@letta-ai/letta-client/resources/agents/agents";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { getClient } from "./client";
import {
  type SubagentConfig,
  type SubagentType,
  getSubagentConfig,
} from "./subagents";

/**
 * Stored subagent information for resume functionality
 */
interface SubagentInfo {
  agentId: string;
  type: SubagentType;
  createdAt: Date;
}

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
 * Global registry of spawned subagents for resume functionality
 */
const subagentRegistry = new Map<string, SubagentInfo>();

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
export async function getConversationHistory(
  agentId: string,
): Promise<MessageCreate[]> {
  const client = await getClient();

  // Get the agent's message history
  const messagesPage = await client.agents.messages.list(agentId, {
    limit: 100, // Get last 100 messages for context
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
 * Create a subagent with specified type and configuration
 * Uses dynamic import to reuse createAgent while avoiding circular dependencies
 */
async function createSubagent(
  type: SubagentType,
  model: string,
  userPrompt: string,
): Promise<AgentResponse> {
  const config = getSubagentConfig(type);

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
    "openai/text-embedding-3-small",
    undefined, // no update args
    true, // force new blocks (subagents shouldn't share memory)
    undefined, // no skills directory
    true, // parallel tool calls
    false, // no sleeptime
    systemPrompt, // custom system prompt for this subagent type
  );

  // Unlink tools that aren't allowed for this subagent type
  const allTools = agent.tools || [];
  const allowedToolNames = new Set(config.allowedTools);

  // Filter to keep only allowed tools (and base tools like memory, web_search, etc.)
  const remainingTools = allTools.filter((tool) => {
    if (!tool.name) return true; // Keep tools without names (shouldn't happen)
    // Keep if it's an allowed tool OR a base Letta tool (memory, web_search, etc.)
    return (
      allowedToolNames.has(tool.name as never) ||
      ["memory", "web_search", "conversation_search", "fetch_webpage"].includes(
        tool.name,
      )
    );
  });

  // Extract tool IDs from remaining tools
  const remainingToolIds = remainingTools
    .map((t) => t.id)
    .filter((id): id is string => typeof id === "string");

  // Update agent with filtered tools
  if (remainingToolIds.length !== allTools.length) {
    await client.agents.modify(agent.id, {
      tool_ids: remainingToolIds,
    });
  }

  return agent;
}

/**
 * Execute a subagent and collect its final report by spawning letta in headless mode
 */
async function executeSubagent(
  agent: AgentResponse,
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

    // Spawn letta in headless mode with JSON output
    const proc = Bun.spawn(
      ["letta", "--agent", agent.id, "-p", userPrompt, "--output-format", "json"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      }
    );

    // Collect stdout and stderr
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    // Check for errors
    if (exitCode !== 0) {
      return {
        agentId: agent.id,
        report: "",
        success: false,
        error: `Subagent execution failed with exit code ${exitCode}: ${stderr}`,
      };
    }

    // Parse JSON output
    try {
      const result = JSON.parse(stdout);

      if (result.is_error || result.subtype !== "success") {
        return {
          agentId: agent.id,
          report: "",
          success: false,
          error: result.result || "Unknown error",
        };
      }

      return {
        agentId: agent.id,
        report: result.result || "",
        success: true,
      };
    } catch (parseError) {
      return {
        agentId: agent.id,
        report: "",
        success: false,
        error: `Failed to parse subagent output: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
      };
    }
  } catch (error) {
    return {
      agentId: agent.id,
      report: "",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Spawn a subagent and execute it autonomously
 */
export async function spawnSubagent(
  mainAgentId: string,
  type: SubagentType,
  prompt: string,
  description: string,
  model?: string,
): Promise<SubagentResult> {
  const config = getSubagentConfig(type);
  const resolvedModel = await resolveSubagentModel(model, config);

  // Get conversation history from main agent
  const conversationHistory = await getConversationHistory(mainAgentId);

  // Create subagent with appropriate configuration
  const subagent = await createSubagent(type, resolvedModel, prompt);

  // Register subagent for potential resume
  subagentRegistry.set(subagent.id, {
    agentId: subagent.id,
    type,
    createdAt: new Date(),
  });

  // Execute subagent and collect final report
  const result = await executeSubagent(subagent, conversationHistory, prompt);

  // Clean up subagent after execution
  try {
    const client = await getClient();
    await client.agents.delete(subagent.id);
  } catch (error) {
    console.warn(
      `Failed to delete subagent ${subagent.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return result;
}

/**
 * Resume a previously spawned subagent
 */
export async function resumeSubagent(
  mainAgentId: string,
  subagentId: string,
  prompt: string,
): Promise<SubagentResult> {
  const subagentInfo = subagentRegistry.get(subagentId);

  if (!subagentInfo) {
    return {
      agentId: subagentId,
      report: "",
      success: false,
      error: `Subagent ${subagentId} not found in registry`,
    };
  }

  const client = await getClient();

  try {
    // Check if subagent still exists
    const subagent = await client.agents.retrieve(subagentId);

    // Get fresh conversation history
    const conversationHistory = await getConversationHistory(mainAgentId);

    // Execute subagent with new prompt
    return await executeSubagent(subagent, conversationHistory, prompt);
  } catch (error) {
    return {
      agentId: subagentId,
      report: "",
      success: false,
      error: `Failed to resume subagent: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get information about a spawned subagent
 */
export function getSubagentInfo(subagentId: string): SubagentInfo | undefined {
  return subagentRegistry.get(subagentId);
}

/**
 * Clear old subagents from registry (cleanup)
 */
export function cleanupSubagentRegistry(maxAgeMs = 24 * 60 * 60 * 1000) {
  const now = Date.now();
  for (const [id, info] of subagentRegistry.entries()) {
    if (now - info.createdAt.getTime() > maxAgeMs) {
      subagentRegistry.delete(id);
    }
  }
}
