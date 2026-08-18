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
        request_id: "v2-list",
        agent_id: "agent-local-v2",
        include_references: true,
      } as ListMemoryCommand,
      {} as WebSocket,
      safeSocketSend,
      {
        ensureLocalMemfsCheckout: async () => {},
        getMemoryFilesystemRoot: () => memoryDir,
        isMemfsEnabledOnServer: async () => true,
        memoryFormat: "memfs-v2",
      },
    );

    const entries = messages.flatMap((message) =>
      Array.isArray(message.entries) ? message.entries : [],
    ) as Array<Record<string, unknown>>;
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
});
