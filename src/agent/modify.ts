// src/agent/modify.ts
// Utilities for modifying agent configuration

import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { getClient } from "./client";

/**
 * Updates an agent's model and LLM configuration.
 *
 * Note: Currently requires two PATCH calls due to SDK limitation.
 * Once SDK is fixed to allow contextWindow on PATCH, simplify this code to a single call.
 *
 * @param agentId - The agent ID
 * @param modelHandle - The model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @param updateArgs - Additional LLM config args (contextWindow, reasoningEffort, verbosity, etc.)
 * @returns The updated LLM configuration from the server
 */
export async function updateAgentLLMConfig(
  agentId: string,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<LlmConfig> {
  const client = await getClient();

  // Step 1: Update model (top-level field)
  await client.agents.modify(agentId, { model: modelHandle });

  // Step 2: Get updated agent to retrieve current llm_config
  const agent = await client.agents.retrieve(agentId);
  let finalConfig = agent.llm_config;

  // Step 3: If we have updateArgs, merge them into llm_config and patch again
  if (updateArgs && Object.keys(updateArgs).length > 0) {
    const updatedLlmConfig = {
      ...finalConfig,
      ...updateArgs,
    } as LlmConfig;
    await client.agents.modify(agentId, { llm_config: updatedLlmConfig });

    // Retrieve final state
    const finalAgent = await client.agents.retrieve(agentId);
    finalConfig = finalAgent.llm_config;
  }

  return finalConfig;
}
