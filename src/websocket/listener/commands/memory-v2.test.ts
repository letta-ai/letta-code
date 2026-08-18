import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import type { ListMemoryCommand } from "@/types/protocol_v2";
import { handleListMemoryCommand } from "./memory";
import type { SafeSocketSend } from "./types";

describe("MemFS v2 list-memory protocol", () => {
  let memoryDir = "";

  afterEach(async () => {
    if (memoryDir) await rm(memoryDir, { recursive: true, force: true });
  });

  /** Collect entries from a list_memory invocation for the given format. */
  async function listEntries(
    format: "memfs-v1" | "memfs-v2",
    options: { requestId?: string; includeReferences?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const messages: Array<Record<string, unknown>> = [];
    const safeSocketSend = ((
      _socket: WebSocket,
      payload: Record<string, unknown>,
    ) => {
      messages.push(payload);
      return true;
    }) as SafeSocketSend;
    await handleListMemoryCommand(
      {
        type: "list_memory",
        request_id: options.requestId ?? "test",
        agent_id: "agent-local",
        include_references: options.includeReferences,
      } as ListMemoryCommand,
      {} as WebSocket,
      safeSocketSend,
      {
        ensureLocalMemfsCheckout: async () => {},
        getMemoryFilesystemRoot: () => memoryDir,
        isMemfsEnabledOnServer: async () => true,
        memoryFormat: format,
      },
    );
    return messages.flatMap((message) =>
      Array.isArray(message.entries) ? message.entries : [],
    ) as Array<Record<string, unknown>>;
  }

  test("projects root files, indexed children, and Markdown references", async () => {
    memoryDir = mkdtempSync(join(tmpdir(), "list-memory-v2-"));
    mkdirSync(join(memoryDir, ".git"));
    mkdirSync(join(memoryDir, "projects"));
    mkdirSync(join(memoryDir, "silent"));
    mkdirSync(join(memoryDir, "skills", "example"), { recursive: true });
    writeFileSync(
      join(memoryDir, "MEMORY.md"),
      "# Memory\n\n[Projects](projects/MEMORY.md)\n",
    );
    writeFileSync(
      join(memoryDir, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent.\n',
    );
    writeFileSync(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n");
    writeFileSync(
      join(memoryDir, "projects", "active.md"),
      '---\nname: "Active"\ndescription: "Project"\n---\n[Persona](../persona.md)\n',
    );
    writeFileSync(join(memoryDir, "silent", "ignored.md"), "Ignored.\n");
    writeFileSync(join(memoryDir, "skills", "example", "SKILL.md"), "Skill.\n");

    const entries = await listEntries("memfs-v2", {
      requestId: "v2-list",
      includeReferences: true,
    });
    expect(entries.map((entry) => entry.relative_path)).toEqual([
      "projects/active.md",
      "projects/MEMORY.md",
      "MEMORY.md",
      "persona.md",
    ]);
    expect(
      entries.find((entry) => entry.relative_path === "persona.md"),
    ).toMatchObject({
      is_system: true,
      description: "Identity",
    });
    expect(
      entries.find((entry) => entry.relative_path === "MEMORY.md"),
    ).toMatchObject({
      references: ["projects/MEMORY.md"],
      is_system: true,
    });
    expect(
      entries.find((entry) => entry.relative_path === "projects/active.md"),
    ).toMatchObject({
      references: ["persona.md"],
      is_system: false,
    });
  });

  test("excludes nested Markdown when an intermediate parent lacks MEMORY.md", async () => {
    memoryDir = mkdtempSync(join(tmpdir(), "list-memory-v2-nested-"));
    mkdirSync(join(memoryDir, ".git"));
    mkdirSync(join(memoryDir, "projects", "active"), { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n");
    // projects/active/ has no MEMORY.md — task.md must be excluded
    writeFileSync(
      join(memoryDir, "projects", "active", "task.md"),
      '---\nname: "Task"\ndescription: "Task"\n---\nBody.\n',
    );

    const entries = await listEntries("memfs-v2", { requestId: "v2-nested" });
    const paths = entries.map((entry) => entry.relative_path);
    expect(paths).not.toContain("projects/active/task.md");
    expect(paths).toContain("projects/MEMORY.md");
    expect(paths).toContain("MEMORY.md");
  });

  test("v1 format lists all Markdown files without MEMORY.md gating", async () => {
    memoryDir = mkdtempSync(join(tmpdir(), "list-memory-v1-"));
    mkdirSync(join(memoryDir, ".git"));
    mkdirSync(join(memoryDir, "system"), { recursive: true });
    mkdirSync(join(memoryDir, "silent"));
    mkdirSync(join(memoryDir, "skills", "example"), { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(memoryDir, "system", "persona.md"),
      '---\ndescription: "Identity"\n---\nPersistent.\n',
    );
    // v1 has no MEMORY.md gating — silent/ignored.md should appear
    writeFileSync(
      join(memoryDir, "silent", "ignored.md"),
      '---\ndescription: "Ignored"\n---\nBody.\n',
    );
    // v1 does not exclude skills/
    writeFileSync(
      join(memoryDir, "skills", "example", "SKILL.md"),
      '---\ndescription: "Skill"\n---\nSkill body.\n',
    );

    const entries = await listEntries("memfs-v1", { requestId: "v1-list" });
    expect(entries.map((entry) => entry.relative_path)).toEqual([
      "system/persona.md",
      "silent/ignored.md",
      "skills/example/SKILL.md",
      "MEMORY.md",
    ]);
    // v1 core memory is system/ prefixed
    expect(
      entries.find((entry) => entry.relative_path === "system/persona.md"),
    ).toMatchObject({ is_system: true });
    expect(
      entries.find((entry) => entry.relative_path === "silent/ignored.md"),
    ).toMatchObject({ is_system: false });
  });
});
