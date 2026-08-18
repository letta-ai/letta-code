import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildParentMemorySnapshot } from "@/cli/helpers/reflection-transcript";

describe("MemFS v2 reflection snapshot", () => {
  let memoryDir = "";

  afterEach(async () => {
    if (memoryDir) await rm(memoryDir, { recursive: true, force: true });
  });

  test("inlines root memory and hides skills and silent directories", async () => {
    memoryDir = await mkdtemp(join(tmpdir(), "reflection-memory-v2-"));
    await mkdir(join(memoryDir, "projects"), { recursive: true });
    await mkdir(join(memoryDir, "silent"), { recursive: true });
    await mkdir(join(memoryDir, "skills", "example"), { recursive: true });
    await writeFile(join(memoryDir, "MEMORY.md"), "# Memory\n");
    await writeFile(
      join(memoryDir, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent persona.\n',
    );
    await writeFile(join(memoryDir, "projects", "MEMORY.md"), "# Projects\n");
    await writeFile(
      join(memoryDir, "projects", "active.md"),
      "Deferred detail.\n",
    );
    await writeFile(
      join(memoryDir, "silent", "ignored.md"),
      "Silent detail.\n",
    );
    await writeFile(
      join(memoryDir, "skills", "example", "SKILL.md"),
      "Skill.\n",
    );

    const snapshot = await buildParentMemorySnapshot(memoryDir, {
      memoryFormat: "memfs-v2",
    });
    expect(snapshot).toContain("<path>$MEMORY_DIR/persona.md</path>");
    expect(snapshot).toContain("Persistent persona.");
    expect(snapshot).toContain("projects/");
    expect(snapshot).toContain("active.md");
    expect(snapshot).not.toContain("Deferred detail.");
    expect(snapshot).not.toContain("silent");
    expect(snapshot).not.toContain("skills");
  });
});
