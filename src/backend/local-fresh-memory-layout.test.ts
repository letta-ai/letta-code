import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureRootMemoryBlockOnLocalCreateBody,
  initialMemoryFilesFromCreateBody,
} from "@/backend/local/initial-memory";
import { LocalBackend } from "@/backend/local/local-backend";

describe("fresh local agent memory layout", () => {
  test("rejects labels that collapse onto the same root path", () => {
    const body = ensureRootMemoryBlockOnLocalCreateBody({
      memory_blocks: [
        { label: "profile/details", value: "nested" },
        { label: "profile_details", value: "flat" },
      ],
    } as never);

    expect(() => initialMemoryFilesFromCreateBody(body)).toThrow(
      "Initial memory path collision at profile_details.md",
    );
  });

  test("creates and compiles the canonical root MemFS layout", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-root-memfs-"));
    try {
      const backend = new LocalBackend({ storageDir });
      const agent = await backend.createAgent({
        name: "Root Memory Agent",
        system: "base {CORE_MEMORY}",
        memory_blocks: [
          {
            label: "persona",
            value: "I am rooted.",
            description: "Who the agent is",
          },
          {
            label: "human",
            value: "The human prefers concise answers.",
            description: "Who the agent works with",
          },
        ],
      } as never);
      const memoryDir = join(storageDir, "memfs", agent.id, "memory");

      expect((await readdir(memoryDir)).sort()).toEqual([
        ".git",
        "MEMORY.md",
        "human.md",
        "persona.md",
      ]);
      expect(await readFile(join(memoryDir, "MEMORY.md"), "utf8")).toBe(
        "# Memory\n",
      );
      expect(await readFile(join(memoryDir, "persona.md"), "utf8")).toContain(
        'name: "Persona"',
      );
      expect(await readFile(join(memoryDir, "persona.md"), "utf8")).toContain(
        'description: "Who the agent is"',
      );
      expect(() =>
        execFileSync("git", ["show", "HEAD:system/persona.md"], {
          cwd: memoryDir,
          stdio: "ignore",
        }),
      ).toThrow();

      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const compiled = await backend.recompileConversation(conversation.id, {
        agent_id: agent.id,
        dry_run: true,
      } as never);
      expect(compiled).toContain('<file name="MEMORY.md">');
      expect(compiled).toContain('<file name="persona.md">');
      expect(compiled).toContain("I am rooted.");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
