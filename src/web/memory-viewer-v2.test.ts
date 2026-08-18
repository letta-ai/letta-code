import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
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

  test("excludes nested Markdown when an intermediate parent lacks MEMORY.md", () => {
    memoryDir = mkdtempSync(join(tmpdir(), "memory-viewer-v2-nested-"));
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    mkdirSync(join(memoryDir, "projects", "active"), { recursive: true });
    writeFileSync(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n");
    // projects/active/ has no MEMORY.md, so task.md must be excluded
    writeFileSync(
      join(memoryDir, "projects", "active", "task.md"),
      '---\nname: "Task"\ndescription: "Task"\n---\nBody.',
    );
    // Add the intermediate MEMORY.md — task.md should now appear
    writeFileSync(
      join(memoryDir, "projects", "active", "MEMORY.md"),
      "# Active\n",
    );

    let files = collectFiles(memoryDir, "memfs-v2");
    expect(files.map((file) => file.path)).toContain("projects/active/task.md");

    // Remove the intermediate MEMORY.md and task.md should disappear
    unlinkSync(join(memoryDir, "projects", "active", "MEMORY.md"));
    files = collectFiles(memoryDir, "memfs-v2");
    expect(files.map((file) => file.path)).not.toContain(
      "projects/active/task.md",
    );
    // projects/MEMORY.md and root files remain
    expect(files.map((file) => file.path)).toContain("projects/MEMORY.md");
    expect(files.map((file) => file.path)).toContain("MEMORY.md");
  });

  test("v1 format includes all Markdown files without MEMORY.md gating", () => {
    memoryDir = mkdtempSync(join(tmpdir(), "memory-viewer-v1-"));
    writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
    mkdirSync(join(memoryDir, "system"), { recursive: true });
    writeFileSync(
      join(memoryDir, "system", "persona.md"),
      '---\ndescription: "Identity"\n---\nPersistent.',
    );
    mkdirSync(join(memoryDir, "silent"));
    // v1 has no MEMORY.md gating — silent/ignored.md should appear
    writeFileSync(
      join(memoryDir, "silent", "ignored.md"),
      '---\ndescription: "Ignored"\n---\nBody.',
    );
    mkdirSync(join(memoryDir, "skills", "example"), { recursive: true });
    // v1 does not exclude skills/ — all .md files are projected
    writeFileSync(
      join(memoryDir, "skills", "example", "SKILL.md"),
      '---\ndescription: "Skill"\n---\nSkill body.',
    );

    const files = collectFiles(memoryDir, "memfs-v1");
    expect(files.map((file) => file.path)).toEqual([
      "system/persona.md",
      "silent/ignored.md",
      "skills/example/SKILL.md",
      "MEMORY.md",
    ]);
    // v1 core memory is system/ prefixed
    expect(
      files.find((file) => file.path === "system/persona.md")?.isSystem,
    ).toBe(true);
    expect(
      files.find((file) => file.path === "silent/ignored.md")?.isSystem,
    ).toBe(false);
  });
});
