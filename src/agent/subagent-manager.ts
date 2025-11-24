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

import type { AgentResponse } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  AssistantMessage,
  LettaStreamingResponse,
  SystemMessage,
  UserMessage,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getClient } from "./client";
import { createAgent } from "./create";
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
 */
function resolveSubagentModel(
  modelShorthand: string | undefined,
  config: SubagentConfig,
): string {
  if (!modelShorthand) {
    return config.recommendedModel;
  }

  // Map short names to full identifiers
  const modelMap: Record<string, string> = {
    haiku: "anthropic/claude-haiku-4-20250514",
    sonnet: "anthropic/claude-sonnet-4-5-20250929",
    opus: "anthropic/claude-opus-4-20250514",
  };

  return modelMap[modelShorthand] || config.recommendedModel;
}

/**
 * Extract conversation history from main agent
 */
export async function getConversationHistory(
  agentId: string,
): Promise<Array<UserMessage | AssistantMessage | SystemMessage>> {
  const client = await getClient();

  // Get the agent's message history
  const messages = await client.agents.messages.list(agentId, {
    limit: 100, // Get last 100 messages for context
  });

  // Convert message history to format suitable for new agent
  const history: Array<UserMessage | AssistantMessage | SystemMessage> = [];

  for (const msg of messages) {
    if (msg.message_type === "user_message") {
      history.push({
        role: "user" as const,
        content: msg.text || "",
      });
    } else if (msg.message_type === "assistant_message") {
      history.push({
        role: "assistant" as const,
        content: msg.text || "",
      });
    } else if (msg.message_type === "system_message") {
      history.push({
        role: "system" as const,
        content: msg.text || "",
      });
    }
  }

  return history;
}

/**
 * Create a subagent with specified type and configuration
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

  const client = await getClient();

  // Create a new agent with subagent configuration
  // We'll use createAgent but with restricted tools
  const agent = await createAgent(
    `subagent-${type}-${Date.now()}`,
    model,
    "openai/text-embedding-3-small",
    undefined, // no update args
    true, // force new blocks (subagents shouldn't share memory)
    undefined, // no skills directory
    true, // parallel tool calls
    false, // no sleeptime
  );

  // Update the agent's system prompt to use the subagent-specific prompt
  await client.agents.update(agent.id, {
    system: systemPrompt,
  });

  // Unlink tools that aren't allowed for this subagent type
  const allTools = agent.tools || [];
  const allowedTools = config.allowedTools;

  const toolsToUnlink = allTools.filter(
    (tool) => !allowedTools.includes(tool as never),
  );

  if (toolsToUnlink.length > 0) {
    // Unlink unauthorized tools
    for (const tool of toolsToUnlink) {
      try {
        await client.agents.tools.remove(agent.id, {
          tool_name: tool,
        });
      } catch (error) {
        console.warn(
          `Failed to unlink tool ${tool} from subagent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  return agent;
}

/**
 * Execute a subagent and collect its final report
 */
async function executeSubagent(
  agent: AgentResponse,
  conversationHistory: Array<UserMessage | AssistantMessage | SystemMessage>,
  userPrompt: string,
): Promise<SubagentResult> {
  const client = await getClient();

  try {
    // Send conversation history + user prompt to subagent
    const messages = [
      ...conversationHistory.map((msg) => ({
        role: msg.role,
        text: msg.content,
      })),
      {
        role: "user" as const,
        text: userPrompt,
      },
    ];

    // Send messages and stream the response
    const stream = await client.agents.messages.stream(agent.id, {
      messages: messages.map((msg) => ({
        role: msg.role,
        text: msg.text,
      })),
      stream_tokens: true,
      background: true,
    });

    // Collect all assistant messages into final report
    let report = "";
    const chunks: LettaStreamingResponse[] = [];

    for await (const chunk of stream) {
      chunks.push(chunk);

      if (
        chunk.message_type === "assistant_message" ||
        chunk.message_type === "internal_monologue"
      ) {
        report += chunk.text || "";
      }

      // Handle tool calls if needed
      // For now, we'll let the backend handle tool execution
    }

    return {
      agentId: agent.id,
      report: report.trim(),
      success: true,
    };
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
  const resolvedModel = resolveSubagentModel(model, config);

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
