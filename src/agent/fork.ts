/**
 * Agent forking utilities
 * Allows agents to clone themselves and create subagents
 */

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "./client";

// Maximum fork depth to prevent fork bombs
const MAX_FORK_DEPTH = 3;

/**
 * Extract fork depth from agent tags
 */
function getForkDepth(agent: AgentState): number {
  const depthTag = agent.tags?.find((t) => t.startsWith("fork-depth:"));
  if (!depthTag) return 0;
  const depthStr = depthTag.split(":")[1];
  return depthStr ? Number.parseInt(depthStr, 10) : 0;
}

/**
 * Generate a short random ID for fork naming
 */
function generateShortId(): string {
  return Math.random().toString(36).substring(2, 8);
}

export interface ForkOptions {
  isolated?: boolean;
  freshConversation?: boolean;
  keep?: boolean;
  name?: string;
}

/**
 * Fork an existing agent by cloning its configuration
 *
 * @param parentAgentId - ID of the agent to fork
 * @param options - Fork configuration options
 * @returns The newly created forked agent
 */
export async function forkAgent(
  parentAgentId: string,
  options: ForkOptions = {},
): Promise<AgentState> {
  const client = await getClient();

  // Retrieve parent agent to check fork depth
  const parentAgent = await client.agents.retrieve(parentAgentId, {
    include: ["agent.blocks", "agent.tools"],
  });

  // Check fork depth limit (prevent fork bombs)
  const currentDepth = getForkDepth(parentAgent);
  if (currentDepth >= MAX_FORK_DEPTH) {
    throw new Error(
      `Fork depth limit reached (${MAX_FORK_DEPTH}). Cannot fork agent to prevent fork bombs.`,
    );
  }

  // Export parent agent as JSON
  const exportedData = await client.agents.exportFile(parentAgentId);

  // Parse exported JSON
  const exported =
    typeof exportedData === "string" ? JSON.parse(exportedData) : exportedData;

  // Modify exported data for fork
  const agent = exported.agents[0];
  const newDepth = currentDepth + 1;
  const shortId = generateShortId();

  // Update name
  agent.name = options.name || `${agent.name}-fork-${shortId}`;

  // Update tags
  agent.tags = agent.tags || [];
  agent.tags.push("origin:letta-code-fork");
  agent.tags.push(`parent:${parentAgentId}`);
  agent.tags.push(`fork-depth:${newDepth}`);
  if (!options.keep) {
    agent.tags.push("ephemeral:true");
  }

  // For isolated mode, keep exported blocks (new blocks will be created on import)
  // For shared mode, we'll swap blocks after import (keep exported blocks for now)

  // Clear conversation history if requested
  if (options.freshConversation) {
    // Messages aren't included in export by default, so nothing to do
    // But set initial_message_sequence to empty to be explicit
    agent.initial_message_sequence = [];
  }

  // Convert back to JSON for import
  const modifiedExport = JSON.stringify(exported);

  // Create a Blob/File for upload
  const blob = new Blob([modifiedExport], { type: "application/json" });
  const file = new File([blob], "agent-fork.json", {
    type: "application/json",
  });

  // Import the modified agent
  const importResult = await client.agents.importFile({
    file,
  });

  if (!importResult.agent_ids || importResult.agent_ids.length === 0) {
    throw new Error("Failed to import forked agent");
  }

  const forkedAgentId = importResult.agent_ids[0];
  if (!forkedAgentId) {
    throw new Error("Imported agent ID is undefined");
  }

  // If shared memory mode, swap imported blocks for parent's blocks
  if (!options.isolated) {
    const parentBlockIds = parentAgent.blocks?.map((b) => b.id) || [];
    await client.agents.modify(forkedAgentId, {
      block_ids: parentBlockIds,
    });
  }

  // Wait for agent to fully initialize (imported agents may need time)
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Register for cleanup if ephemeral
  if (!options.keep) {
    registerEphemeralAgent(forkedAgentId);
  }

  // Retrieve and return the forked agent
  return await client.agents.retrieve(forkedAgentId);
}

/**
 * Registry of ephemeral forked agents for cleanup
 */
const ephemeralAgents = new Set<string>();

/**
 * Register an agent for cleanup on process exit
 */
function registerEphemeralAgent(agentId: string) {
  ephemeralAgents.add(agentId);
}

/**
 * Clean up all ephemeral forked agents
 */
export async function cleanupEphemeralAgents() {
  if (ephemeralAgents.size === 0) return;

  const client = await getClient();
  const deletePromises = Array.from(ephemeralAgents).map(async (agentId) => {
    try {
      await client.agents.delete(agentId);
    } catch (error) {
      // Silently fail - agent might already be deleted
      console.warn(
        `Failed to cleanup ephemeral agent ${agentId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  await Promise.all(deletePromises);
  ephemeralAgents.clear();
}

// Register cleanup on process exit
process.on("exit", () => {
  // Note: This is synchronous, so async cleanup won't work here
  // We'll need to call cleanupEphemeralAgents() explicitly before exit
});
