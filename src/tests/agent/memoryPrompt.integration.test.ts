import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createAgent } from "../../agent/create";
import { updateAgentSystemPromptMemfs } from "../../agent/modify";
import { getClient } from "../../backend/api/client";

const describeIntegration = process.env.LETTA_API_KEY
  ? describe
  : describe.skip;

describeIntegration("memory prompt integration", () => {
  const createdAgentIds: string[] = [];

  beforeAll(() => {
    // Avoid polluting user's normal local LRU state in integration runs.
    process.env.LETTA_CODE_AGENT_ROLE = "subagent";
  });

  afterAll(async () => {
    const client = await getClient();
    for (const agentId of createdAgentIds) {
      try {
        await client.agents.delete(agentId);
      } catch {
        // Best-effort cleanup.
      }
    }
  });

  test(
    "custom system prompts are treated as complete prompts in both memory modes",
    async () => {
      const customPrompt = [
        "You are a test agent.",
        "Follow user instructions precisely.",
      ].join("\n");

      const created = await createAgent({
        name: `prompt-memfs-${Date.now()}`,
        systemPromptCustom: customPrompt,
        memoryPromptMode: "memfs",
      });
      createdAgentIds.push(created.agent.id);

      const client = await getClient();

      let fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(customPrompt);
      expect(fetched.system).not.toContain("# Memory");
      expect(fetched.system).not.toContain("MemFS");

      const enableAgain = await updateAgentSystemPromptMemfs(
        created.agent.id,
        true,
      );
      expect(enableAgain.success).toBe(true);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(customPrompt);

      const disable = await updateAgentSystemPromptMemfs(
        created.agent.id,
        false,
      );
      expect(disable.success).toBe(true);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(customPrompt);

      const reEnable = await updateAgentSystemPromptMemfs(
        created.agent.id,
        true,
      );
      expect(reEnable.success).toBe(true);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(customPrompt);
    },
    { timeout: 120000 },
  );
});
