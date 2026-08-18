import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "@/agent/prompt-assets";
import { LocalBackend } from "@/backend/local/local-backend";
import { getLocalBackendMemoryFilesystemRoot } from "@/backend/local/paths";

describe("local backend MemFS v2 creation", () => {
  test("creates a tagged agent with the v2 prompt and root memory files", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-memfs-v2-"));
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: true });
      const agent = await backend.createAgent({
        name: "V2 agent",
        tags: ["memfs-v2"],
        system: buildSystemPrompt("default", "local-memfs"),
        memory_blocks: [
          {
            label: "persona",
            value: "Persistent persona.",
            description: "Identity",
          },
          {
            label: "human",
            value: "User context.",
            description: "User",
          },
        ],
      } as never);

      expect(agent.tags).toContain("memfs-v2");
      expect(agent.system).toBe(buildSystemPrompt("default", "local-memfs-v2"));
      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agent.id,
        storageDir,
      );
      expect(await readFile(join(memoryDir, "MEMORY.md"), "utf8")).toContain(
        "[Persona](persona.md)",
      );
      expect(await readFile(join(memoryDir, "persona.md"), "utf8")).toBe(
        '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent persona.',
      );
      expect(await readFile(join(memoryDir, "human.md"), "utf8")).toBe(
        '---\nname: "Human"\ndescription: "User"\n---\nUser context.',
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
