import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GIT_MEMORY_ENABLED_TAG } from "@/agent/memory-git";
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
    label: "project/gotchas",
    value: "Use Bun.",
    description: "Parity gotchas",
  },
  {
    label: "reference/details",
    value:
      "External-looking labels passed as memory blocks stay in external memory.",
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

/**
 * Assert structural properties of compiled prompts.
 *
 * Instead of full-string equality (which produces massive, hard-to-debug diffs),
 * we verify:
 * 1. System-memory blocks (persona, human, project/gotchas) appear with
 *    <projection> tags under <memory>
 * 2. External-memory blocks (reference/...) appear in <external_projection>
 *    and NOT as in-context system memory
 * 3. Both API and local prompts satisfy the same structural constraints
 */
function assertPromptStructure(prompt: string, source: "API" | "local"): void {
  const normalized = normalizeCompiledPrompt(prompt);

  // System-memory blocks should have projection tags
  expect(normalized, `[${source}] persona block should be projected`).toContain(
    "<projection>$MEMORY_DIR/system/persona.md</projection>",
  );
  expect(normalized, `[${source}] human block should be projected`).toContain(
    "<projection>$MEMORY_DIR/system/human.md</projection>",
  );
  expect(
    normalized,
    `[${source}] project/gotchas block should be projected`,
  ).toContain("<projection>$MEMORY_DIR/system/project/gotchas.md</projection>");

  // System-memory values should appear in-context
  expect(
    normalized,
    `[${source}] persona value should appear in prompt`,
  ).toContain("I am parity persona.");
  expect(
    normalized,
    `[${source}] human value should appear in prompt`,
  ).toContain("The user is parity human.");
  expect(
    normalized,
    `[${source}] project/gotchas value should appear in prompt`,
  ).toContain("Use Bun.");

  // External-memory block (reference/details) should be in external_projection
  expect(
    normalized,
    `[${source}] external projection section should exist`,
  ).toContain("<external_projection>");
  expect(
    normalized,
    `[${source}] reference/ should appear in external projection`,
  ).toContain("reference/");
  expect(
    normalized,
    `[${source}] details.md should appear in external projection`,
  ).toContain("details.md");

  // reference/details should NOT appear as a system-memory projection
  expect(
    normalized,
    `[${source}] reference/details should not be a system projection`,
  ).not.toContain(
    "<projection>$MEMORY_DIR/system/reference/details.md</projection>",
  );

  // The external block value should NOT appear in-context (it's progressive)
  expect(
    normalized,
    `[${source}] reference/details value should not appear in prompt`,
  ).not.toContain(
    "External-looking labels passed as memory blocks stay in external memory.",
  );
}

describe("local/API system prompt parity", () => {
  test("compiles system-memory blocks with projection tags", async () => {
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

      // Verify API prompt structure
      assertPromptStructure(apiCompiled, "API");

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

      // Verify local prompt structure matches API constraints
      assertPromptStructure(localCompiled, "local");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
      await client.agents.delete(apiAgent.id).catch(() => undefined);
    }
  }, 60000);
});
