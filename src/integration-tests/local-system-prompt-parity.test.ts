import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_MEMORY_ENABLED_TAG } from "@/agent/agent-tags";
import type { AgentCreateBody } from "@/backend";
import { getClient } from "@/backend/api/client";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";

const RAW_SYSTEM_PROMPT = "Parity base.\n\n{CORE_MEMORY}";
const MEMORY_BLOCKS = [
  {
    label: "persona",
    value: "I am parity persona.",
    description: "Parity persona",
  },
  {
    label: "human",
    value: "The user is parity human.",
    description: "Parity human",
  },
  {
    label: "system/project/gotchas",
    value: "Use Bun.",
    description: "Parity gotchas",
  },
  {
    label: "reference/details",
    value:
      "External-looking labels passed as memory blocks stay in system memory.",
    description: "Parity details",
  },
];

function normalizeCompiledPrompt(prompt: string): string {
  return prompt
    .replace(/agent-local-[a-f0-9-]+/g, "<AGENT_ID>")
    .replace(/agent-[a-f0-9-]+/g, "<AGENT_ID>")
    .replace(
      /System prompt last recompiled: .*/g,
      "System prompt last recompiled: <TIMESTAMP>",
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function apiDryRunRecompileWithMemory(agentId: string): Promise<string> {
  const client = await getClient();
  let compiled = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    compiled = String(
      await client.conversations.recompile("default", {
        agent_id: agentId,
        dry_run: true,
      }),
    );
    if (MEMORY_BLOCKS.every((block) => compiled.includes(block.value))) {
      return compiled;
    }
    await Bun.sleep(500);
  }
  return compiled;
}

describe("local/API system prompt parity", () => {
  test("compares API dry-run recompile with local compiled MemFS prompt", async () => {
    if (!process.env.LETTA_API_KEY) {
      console.log("SKIP: Missing env LETTA_API_KEY");
      return;
    }

    await settingsManager.initialize();
    const client = await getClient();
    const apiAgent = await client.agents.create({
      agent_type: "letta_v1_agent",
      name: `Parity Probe ${Date.now()}`,
      description: "temporary local/API system prompt parity probe",
      system: RAW_SYSTEM_PROMPT,
      model: "letta/auto",
      include_base_tools: false,
      include_base_tool_rules: false,
      initial_message_sequence: [],
      memory_blocks: MEMORY_BLOCKS,
      tags: ["origin:letta-code", GIT_MEMORY_ENABLED_TAG],
    } as AgentCreateBody);

    const storageDir = await mkdtemp(join(tmpdir(), "local-parity-"));
    try {
      const apiCompiled = await apiDryRunRecompileWithMemory(apiAgent.id);
      const localBackend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const localAgent = await localBackend.createAgent({
        name: "Parity Probe",
        system: RAW_SYSTEM_PROMPT,
        model: "openai/gpt-test",
        memory_blocks: MEMORY_BLOCKS,
      } as AgentCreateBody);
      const localCompiled = String(
        await localBackend.recompileConversation("default", {
          agent_id: localAgent.id,
          dry_run: true,
        }),
      );

      const normalizedApi = normalizeCompiledPrompt(apiCompiled);
      const normalizedLocal = normalizeCompiledPrompt(localCompiled);
      expect(normalizedLocal).toBe(normalizedApi);
      expect(normalizedLocal).toContain(
        "<projection>$MEMORY_DIR/system/project/gotchas.md</projection>",
      );
      expect(normalizedLocal).toContain(
        "<projection>$MEMORY_DIR/system/reference/details.md</projection>",
      );
      expect(normalizedLocal).toContain(
        "External-looking labels passed as memory blocks stay in system memory.",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
      await client.agents.delete(apiAgent.id).catch(() => undefined);
    }
  }, 60000);
});
