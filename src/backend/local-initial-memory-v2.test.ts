import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMFS_V2_TAG } from "@/agent/agent-tags";
import { LocalBackend } from "@/backend/local";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";

describe("local MemFS v2 initialization", () => {
  let tempDir = "";

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  });

  test("directly tagged agents start with root memory and the v2 prompt", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "local-memfs-v2-init-"));
    const backend = new LocalBackend({
      storageDir: tempDir,
      executionMode: "deterministic",
    });
    const agent = await backend.createAgent({
      name: "V2 agent",
      tags: [MEMFS_V2_TAG],
      memory_blocks: [
        {
          label: "system/persona",
          description: "Who this agent is.",
          value: "Persistent and curious.",
        },
        {
          label: "system/human",
          description: "Facts about the person this agent works with.",
          value: "The person likes concise answers.",
        },
      ],
    } as Parameters<InstanceType<typeof LocalBackend>["createAgent"]>[0]);

    const memoryDir = getLocalBackendMemoryFilesystemRoot(agent.id, tempDir);
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toContain(
      "[Human](human.md) - Who I'm working with",
    );
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).toContain(
      "[Persona](persona.md) - Who I am and how I act",
    );
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).not.toContain(
      "Who this agent is.",
    );
    expect(readFileSync(join(memoryDir, "MEMORY.md"), "utf8")).not.toContain(
      "Facts about the person this agent works with.",
    );
    expect(readFileSync(join(memoryDir, "human.md"), "utf8")).toBe(
      '---\nname: "Human"\ndescription: "Facts about the person this agent works with."\n---\nThe person likes concise answers.',
    );
    expect(readFileSync(join(memoryDir, "persona.md"), "utf8")).toBe(
      '---\nname: "Persona"\ndescription: "Who this agent is."\n---\nPersistent and curious.',
    );
    expect(agent.system).toContain("## Memory files (learning)");
  });
});
