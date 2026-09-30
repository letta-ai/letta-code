import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { settingsManager } from "@/settings-manager";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
  prepareToolExecutionContextForSpecificTools,
} from "@/tools/manager";

const V2_AGENT = "agent-memory-tool-v2";
const V1_AGENT = "agent-memory-tool-v1";
const MEMFS_OFF_AGENT = "agent-memory-tool-off";

function memoryDir(agentId: string): string {
  return getMemoryFilesystemRoot(agentId);
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), content);
}

function commit(root: string, message: string, isoDate: string): void {
  const env = {
    ...process.env,
    GIT_AUTHOR_DATE: isoDate,
    GIT_COMMITTER_DATE: isoDate,
  };
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
      { cwd: root, env, stdio: "ignore" },
    );
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

async function toolNamesFor(agentId: string): Promise<string[]> {
  const { clientTools } = await prepareToolExecutionContextForSpecificTools(
    ["Memory", "Read"],
    { runtimeContext: { agentId } },
  );
  return clientTools.map((tool) => tool.name);
}

async function callMemory(path: string, agentId = V2_AGENT) {
  const { contextId } = await prepareToolExecutionContextForSpecificTools(
    ["Memory"],
    { runtimeContext: { agentId } },
  );
  const result = await executeTool(
    "Memory",
    { path },
    { toolContextId: contextId },
  );
  return { status: result.status, text: String(result.toolReturn) };
}

describe("Memory tool", () => {
  beforeAll(async () => {
    await settingsManager.initialize();
    for (const agentId of [V2_AGENT, V1_AGENT]) {
      settingsManager.setMemfsEnabled(agentId, true);
    }
    settingsManager.setMemfsEnabled(MEMFS_OFF_AGENT, false);

    const v2 = memoryDir(V2_AGENT);
    mkdirSync(v2, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: v2 });
    write(v2, "MEMORY.md", "# Memory\n");
    write(v2, "persona.md", "---\ndescription: Root core file.\n---\nI am.\n");
    write(
      v2,
      "reference/MEMORY.md",
      "# Reference\n\nDesign decisions by [area](reference/a.md).\n\n- a\n",
    );
    write(
      v2,
      "reference/old.md",
      "---\ndescription: Committed first.\n---\nold\n",
    );
    commit(v2, "old", "2026-01-01T00:00:00Z");
    write(
      v2,
      "reference/area/MEMORY.md",
      "# Area\n\nArea summary paragraph.\n",
    );
    write(v2, "reference/area/leaf.md", "leaf\n");
    write(
      v2,
      "reference/new.md",
      "---\ndescription: Committed last.\n---\nnew\n",
    );
    commit(v2, "new", "2026-06-01T00:00:00Z");
    for (let i = 0; i < 11; i++) write(v2, `bulk/f${i}.md`, `${i}\n`);
    write(
      v2,
      "bulk/long.md",
      `${Array.from({ length: 2_100 }, (_, i) => `line ${i}`).join("\n")}\n`,
    );
    write(v2, "skills/demo/SKILL.md", "---\nname: demo\n---\n");

    // Legacy layout: MemFS on but no root MEMORY.md.
    write(memoryDir(V1_AGENT), "system/persona.md", "legacy\n");
    // MemFS off even though a v2 root exists on disk.
    write(memoryDir(MEMFS_OFF_AGENT), "MEMORY.md", "# Memory\n");
  });

  afterEach(() => clearCapturedToolExecutionContexts());

  afterAll(() => {
    for (const agentId of [V2_AGENT, V1_AGENT, MEMFS_OFF_AGENT]) {
      rmSync(join(memoryDir(agentId), ".."), { recursive: true, force: true });
    }
  });

  test("is attached only for MemFS v2 agents", async () => {
    expect(await toolNamesFor(V2_AGENT)).toContain("Memory");
    expect(await toolNamesFor(V1_AGENT)).toEqual(["Read"]);
    expect(await toolNamesFor(MEMFS_OFF_AGENT)).toEqual(["Read"]);

    // The gate is evaluated per turn, so a v1 -> v2 migration attaches it.
    write(memoryDir(V1_AGENT), "MEMORY.md", "# Memory\n");
    try {
      expect(await toolNamesFor(V1_AGENT)).toContain("Memory");
    } finally {
      rmSync(join(memoryDir(V1_AGENT), "MEMORY.md"));
    }
  });

  test("lists a directory's index, then entries by last edit", async () => {
    const { status, text } = await callMemory("reference");
    expect(status).toBe("success");
    expect(text).toContain('<memory_content path="reference">');
    expect(text).toContain("Design decisions by [area](reference/a.md).");
    expect(text).toContain(
      "Paths in this memory are relative to the memory directory.",
    );
    const newer = text.indexOf("reference/new.md");
    const older = text.indexOf("reference/old.md");
    expect(newer).toBeGreaterThan(-1);
    expect(newer).toBeLessThan(older);
    expect(text).toContain(
      '<file description="Committed last.">reference/new.md</file>',
    );
    // Frontmatter-free child index falls back to its first prose paragraph.
    expect(text).toContain(
      '<directory description="Area summary paragraph.">reference/area</directory>',
    );
  });

  test("caps listings and truncates long files like Read", async () => {
    const listing = await callMemory("bulk");
    expect(listing.text).toContain("<note>No MEMORY.md index");
    expect(listing.text.match(/<file>/g)).toHaveLength(10);
    expect(listing.text).toContain(
      "[Output truncated: showing 10 of 12 entries.]",
    );

    const file = await callMemory("bulk/long.md");
    expect(file.text).toContain("line 1999");
    expect(file.text).not.toContain("line 2000");
    expect(file.text).toContain(
      "[File truncated: showing lines 1-2000 of 2100 total lines.",
    );
    expect(file.text).toContain(
      `[Full file: ${join(memoryDir(V2_AGENT), "bulk", "long.md")}]`,
    );
  });

  test("rejects root, skills, escapes, and suggests root-relative paths", async () => {
    const cases: Array<[string, string]> = [
      ["", "memory root is already in your context"],
      ["persona.md", "root core memory and is already in your context"],
      ["skills/demo", 'Use Skill("demo")'],
      ["../other", "Invalid memory path"],
      ["/etc", "relative to the memory directory"],
      ["reference/new", "Did you mean reference/new.md?"],
      ["leaf.md", "Did you mean reference/area/leaf.md?"],
    ];
    for (const [path, message] of cases) {
      const { status, text } = await callMemory(path);
      expect(status).toBe("error");
      expect(text).toContain(message);
    }
  });
});
