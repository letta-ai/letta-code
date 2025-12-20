/**
 * Clone an existing agent by exporting and re-importing it
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { toFile } from "@letta-ai/letta-client";
import { getClient } from "./client";

export interface CloneAgentOptions {
  /** The ID of the agent to clone */
  agentId: string;
  /** Whether to strip messages from the cloned agent (default: false) */
  stripMessages?: boolean;
}

export interface CloneAgentResult {
  /** The newly created cloned agent */
  agent: AgentState;
}

/**
 * Clone an agent by exporting and re-importing it.
 * The cloned agent will have a new ID and name (with "_copy" suffix).
 * Message history is preserved by default.
 */
export async function cloneAgent(
  options: CloneAgentOptions,
): Promise<CloneAgentResult> {
  const client = await getClient();

  // Step 1: Export the source agent
  const exportedData = await client.agents.exportFile(options.agentId);

  // Handle both string and object responses from exportFile
  const jsonString =
    typeof exportedData === "string"
      ? exportedData
      : JSON.stringify(exportedData);

  // Step 2: Create a File object from the exported data
  const file = await toFile(Buffer.from(jsonString), "agent-export.af");

  // Step 3: Import to create a new agent
  const importResponse = await client.agents.importFile({
    file,
    strip_messages: options.stripMessages ?? false,
    override_existing_tools: false,
  });

  if (!importResponse.agent_ids || importResponse.agent_ids.length === 0) {
    throw new Error("Clone failed: no agent IDs returned from import");
  }

  const newAgentId = importResponse.agent_ids[0] as string;
  const agent = await client.agents.retrieve(newAgentId);

  return { agent };
}
