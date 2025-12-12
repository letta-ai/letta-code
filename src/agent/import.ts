/**
 * Import an agent from an AgentFile (.af) template
 */
import { resolve } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getClient } from "./client";
import { getModelUpdateArgs } from "./model";
import { linkToolsToAgent, updateAgentLLMConfig } from "./modify";

export interface ImportAgentOptions {
  filePath: string;
  modelOverride?: string;
  stripMessages?: boolean;
}

export interface ImportAgentResult {
  agent: AgentState;
}

export async function importAgentFromFile(
  options: ImportAgentOptions,
): Promise<ImportAgentResult> {
  const client = await getClient();
  const resolvedPath = resolve(options.filePath);

  // Read file content
  const file = Bun.file(resolvedPath);

  // Import the agent via API
  const importResponse = await client.agents.importFile({
    file: file,
    strip_messages: options.stripMessages ?? true,
    override_existing_tools: false,
  });

  if (!importResponse.agent_ids || importResponse.agent_ids.length === 0) {
    throw new Error("Import failed: no agent IDs returned");
  }

  const agentId = importResponse.agent_ids[0] as string;
  let agent = await client.agents.retrieve(agentId);

  // Override model if specified
  if (options.modelOverride) {
    const updateArgs = getModelUpdateArgs(options.modelOverride);
    await updateAgentLLMConfig(agentId, options.modelOverride, updateArgs);
    agent = await client.agents.retrieve(agentId);
  }

  // Link Letta Code tools to the imported agent
  await linkToolsToAgent(agentId);

  return { agent };
}
