import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "@/web/generate-memory-viewer";

describe("MemFS v2 memory viewer projection", () => {
  let memoryDir = "";

  afterEach(async () => {
    if (memoryDir) await rm(memoryDir, { recursive: true, force: true });
  });

  test("shows root and indexed memory while hiding skills and silent directories", () => {
    memoryDir = mkdtempSync(join(tmpdir(), "memory-viewer-v2-"));
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(memoryDir, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent.',
    );
    mkdirSync(join(memoryDir, "projects"));
    writeFileSync(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n");
    writeFileSync(
      join(memoryDir, "projects", "active.md"),
      '---\nname: "Active"\ndescription: "Active project"\n---\nDetails.',
    );
    mkdirSync(join(memoryDir, "silent"));
    writeFileSync(join(memoryDir, "silent", "ignored.md"), "Ignored.");
    mkdirSync(join(memoryDir, "skills", "example"), { recursive: true });
    writeFileSync(join(memoryDir, "skills", "example", "SKILL.md"), "Skill.");

    const files = collectFiles(memoryDir, "memfs-v2");
    expect(files.map((file) => file.path)).toEqual([
      "projects/active.md",
      "projects/MEMORY.md",
      "MEMORY.md",
      "persona.md",
    ]);
    expect(files.find((file) => file.path === "persona.md")?.isSystem).toBe(
      true,
    );
    expect(
      files.find((file) => file.path === "projects/active.md")?.isSystem,
    ).toBe(false);
  });
});
