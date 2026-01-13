/**
 * Default agents (Memo & Incognito) creation and management.
 *
 * Memo: Stateful agent with full memory - learns and grows with the user.
 * Incognito: Stateless agent - fresh experience without accumulated memory.
 */

import type { Letta } from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { settingsManager } from "../settings-manager";
import { type CreateAgentOptions, createAgent } from "./create";

// Tags used to identify default agents
const MEMO_TAG = "default:memo";
const INCOGNITO_TAG = "default:incognito";

// Memo's persona - minimal soul document emphasizing proactive learning
const MEMO_PERSONA = `My name is Memo. I'm a stateful coding assistant.

I proactively update my memory to remember preferences, project patterns, and working style. I learn and grow over time through our interactions.`;

// Agent descriptions shown in /agents selector
const MEMO_DESCRIPTION = "A stateful coding agent with persistent memory";
const INCOGNITO_DESCRIPTION =
  "A stateless coding agent without memory (incognito mode)";

/**
 * Default agent configurations.
 */
export const DEFAULT_AGENT_CONFIGS: Record<string, CreateAgentOptions> = {
  memo: {
    name: "Memo",
    description: MEMO_DESCRIPTION,
    // Uses default memory blocks and tools (full stateful config)
    // Override persona block with Memo-specific personality
    blockValues: {
      persona: MEMO_PERSONA,
    },
  },
  incognito: {
    name: "Incognito",
    description: INCOGNITO_DESCRIPTION,
    initBlocks: [], // Empty array = no memory blocks created
    baseTools: ["web_search", "conversation_search", "fetch_webpage"], // No memory/memory_apply_patch
  },
};

/**
 * Check if a default agent exists by its tag.
 */
async function findDefaultAgent(
  client: Letta,
  tag: string,
): Promise<AgentState | null> {
  try {
    const result = await client.agents.list({ tags: [tag], limit: 1 });
    return result.items[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Add a tag to an existing agent.
 */
async function addTagToAgent(
  client: Letta,
  agentId: string,
  newTag: string,
): Promise<void> {
  try {
    const agent = await client.agents.retrieve(agentId);
    const currentTags = agent.tags || [];
    if (!currentTags.includes(newTag)) {
      await client.agents.update(agentId, {
        tags: [...currentTags, newTag],
      });
    }
  } catch (err) {
    console.warn(
      `Warning: Failed to add tag to agent: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Ensure default agents exist. Creates missing ones and pins them globally.
 * Respects `createDefaultAgents` setting (defaults to true).
 *
 * @returns The Memo agent (or null if creation disabled/failed).
 */
export async function ensureDefaultAgents(
  client: Letta,
): Promise<AgentState | null> {
  if (!settingsManager.shouldCreateDefaultAgents()) {
    return null;
  }

  let memoAgent: AgentState | null = null;

  try {
    // Check/create Memo
    const existingMemo = await findDefaultAgent(client, MEMO_TAG);
    if (existingMemo) {
      memoAgent = existingMemo;
    } else {
      const { agent } = await createAgent(DEFAULT_AGENT_CONFIGS.memo);
      await addTagToAgent(client, agent.id, MEMO_TAG);
      memoAgent = agent;
      settingsManager.pinGlobal(agent.id);
    }

    // Check/create Incognito
    const existingIncognito = await findDefaultAgent(client, INCOGNITO_TAG);
    if (!existingIncognito) {
      const { agent } = await createAgent(DEFAULT_AGENT_CONFIGS.incognito);
      await addTagToAgent(client, agent.id, INCOGNITO_TAG);
      settingsManager.pinGlobal(agent.id);
    }
  } catch (err) {
    console.warn(
      `Warning: Failed to ensure default agents: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return memoAgent;
}
