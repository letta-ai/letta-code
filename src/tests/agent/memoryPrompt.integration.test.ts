import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { getClient } from "../../agent/client";
import { createAgent } from "../../agent/create";
import { updateAgentSystemPromptMemfs } from "../../agent/modify";
import {
  SYSTEM_PROMPT_MEMFS_ADDON,
  SYSTEM_PROMPT_MEMORY_ADDON,
} from "../../agent/promptAssets";

const describeIntegration = process.env.LETTA_API_KEY
  ? describe
  : describe.skip;

function expectedPrompt(base: string, addon: string): string {
  return `${base.trimEnd()}\n\n${addon.trimStart()}`.trim();
}

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
    "new agent prompt is exact for memfs enabled and disabled modes",
    async () => {
      const base = [
        "You are a test agent.",
        "Follow user instructions precisely.",
      ].join("\n");

      const created = await createAgent({
        name: `prompt-memfs-${Date.now()}`,
        systemPromptCustom: base,
        memoryPromptMode: "memfs",
      });
      createdAgentIds.push(created.agent.id);

      const client = await getClient();

      const expectedMemfs = expectedPrompt(base, SYSTEM_PROMPT_MEMFS_ADDON);
      let fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(expectedMemfs);
      expect((fetched.system.match(/## Memory Filesystem/g) || []).length).toBe(
        1,
      );
      expect((fetched.system.match(/# See what changed/g) || []).length).toBe(
        1,
      );

      const enableAgain = await updateAgentSystemPromptMemfs(
        created.agent.id,
        true,
      );
      expect(enableAgain.success).toBe(true);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(expectedMemfs);

      const disable = await updateAgentSystemPromptMemfs(
        created.agent.id,
        false,
      );
      expect(disable.success).toBe(true);
      const expectedStandard = expectedPrompt(base, SYSTEM_PROMPT_MEMORY_ADDON);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(expectedStandard);
      expect(fetched.system).not.toContain("## Memory Filesystem");
      expect(fetched.system).toContain(
        "Your memory consists of core memory (composed of memory blocks)",
      );

      const reEnable = await updateAgentSystemPromptMemfs(
        created.agent.id,
        true,
      );
      expect(reEnable.success).toBe(true);
      fetched = await client.agents.retrieve(created.agent.id);
      expect(fetched.system).toBe(expectedMemfs);
      expect((fetched.system.match(/# See what changed/g) || []).length).toBe(
        1,
      );
    },
    { timeout: 120000 },
  );
});
