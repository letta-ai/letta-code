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
import { parseMdxFrontmatter } from "./memory";
import { MEMORY_PROMPTS } from "./promptAssets";

// Tags used to identify default agents
export const MEMO_TAG = "default:memo";
export const INCOGNITO_TAG = "default:incognito";

// Memo's persona - loaded from persona_memo.mdx
const MEMO_PERSONA = parseMdxFrontmatter(
  MEMORY_PROMPTS["persona_memo.mdx"] ?? "",
).body;

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
    initBlocks: ["skills", "loaded_skills"], // Only skills blocks, no personal memory
    baseTools: ["web_search", "conversation_search", "fetch_webpage"], // No memory tool
  },
};

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
 * Create a fresh default Memo agent and pin it globally.
 * Always creates a new agent — does NOT search by tag to avoid picking up
 * agents created by other users on shared Letta Cloud orgs.
 *
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

  try {
    const { agent } = await createAgent(DEFAULT_AGENT_CONFIGS.memo);
    await addTagToAgent(client, agent.id, MEMO_TAG);
    settingsManager.pinGlobal(agent.id);
    return agent;
  } catch (err) {
    // Re-throw so caller can handle/exit appropriately
    throw new Error(
      `Failed to create default agents: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
