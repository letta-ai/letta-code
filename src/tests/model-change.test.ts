import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import { getClient } from "../agent/client";
import { settingsManager } from "../settings-manager";

let agentId: string;
const originalModelHandle = "anthropic/claude-3-5-haiku";
const targetModelHandle = "anthropic/claude-3-7-sonnet-20250219";

async function createAgent(model: string) {
  const client = await getClient();
  return await client.agents.create({
    name: "model-change-test",
    model,
  });
}

describe("agent model modify", () => {
  beforeAll(async () => {
    const apiKey = process.env.LETTA_API_KEY;
    if (!apiKey) throw new Error("LETTA_API_KEY must be set to run this test");

    await settingsManager.initialize();
    settingsManager.updateSettings({
      env: {
        ...(settingsManager.getSettings().env || {}),
        LETTA_API_KEY: apiKey,
      },
    });

    const agent = await createAgent(originalModelHandle);
    agentId = agent.id;
  });

  afterAll(async () => {
    if (!agentId) return;
    const client = await getClient();
    await client.agents.delete(agentId);
  });

  test.skip("direct modify updates model handle", async () => {
    const client = await getClient();

    await client.agents.update(agentId, { model: targetModelHandle });
    const fetched = await client.agents.retrieve(agentId);
    expect(fetched.llm_config?.model).toBe(targetModelHandle);

    // revert
    await client.agents.update(agentId, { model: originalModelHandle });
  });

  test.skip("modify with llm_config updates model and config", async () => {
    const client = await getClient();

    const newConfig: Partial<LlmConfig> = {
      reasoning_effort: "high",
      verbosity: "medium",
      context_window: 100000,
    };

    // Use helper to change model then apply llm_config overrides
    const { updateAgentLLMConfig } = await import("../agent/modify");
    await updateAgentLLMConfig(agentId, targetModelHandle, newConfig);

    const fetched = await client.agents.retrieve(agentId);
    expect(fetched.llm_config?.model).toBe(targetModelHandle);
    expect(fetched.llm_config?.reasoning_effort).toBe("high");
    expect(fetched.llm_config?.verbosity).toBe("medium");
    expect(fetched.llm_config?.context_window).toBe(100000);

    // revert
    await updateAgentLLMConfig(agentId, originalModelHandle);
  });
});
