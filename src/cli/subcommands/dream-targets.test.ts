import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addManagedFrontmatter,
  buildTargetInstruction,
  readExistingTarget,
  resolveDreamTarget,
  stripFrontmatter,
  syncTargetIntoMemory,
  writeTarget,
} from "./dream-targets";

describe("resolveDreamTarget", () => {
  test("classifies AGENTS.md / AGENT.md (case-insensitive) as agents-md", () => {
    expect(resolveDreamTarget("./AGENTS.md")).toEqual({
      path: "./AGENTS.md",
      fileName: "AGENTS.md",
      kind: "agents-md",
    });
    expect(resolveDreamTarget("/repo/AGENT.md").kind).toBe("agents-md");
    expect(resolveDreamTarget("/repo/agents.md").kind).toBe("agents-md");
  });

  test("classifies other markdown files as generic", () => {
    expect(resolveDreamTarget("./notes/memory.md")).toEqual({
      path: "./notes/memory.md",
      fileName: "memory.md",
      kind: "generic",
    });
  });

  test("rejects an empty path", () => {
    expect(() => resolveDreamTarget("")).toThrow("expected a file path");
  });
});

describe("buildTargetInstruction", () => {
  test("agents-md points at system/ and includes the standard guidance", () => {
    const target = resolveDreamTarget("./AGENTS.md");
    const out = buildTargetInstruction(target);
    expect(out).toContain("$MEMORY_DIR/system/AGENTS.md");
    expect(out).toContain("agents.md");
    expect(out).toContain("COMMANDS");
    expect(out).toContain("revise it in place");
  });

  test("generic uses generic guidance, not the agents.md standard text", () => {
    const target = resolveDreamTarget("./memory.md");
    const out = buildTargetInstruction(target);
    expect(out).toContain("$MEMORY_DIR/system/memory.md");
    expect(out).not.toContain("agents.md");
  });

  test("tells the agent to skip creation (no placeholder) when nothing is learned", () => {
    const out = buildTargetInstruction(resolveDreamTarget("./AGENTS.md"));
    expect(out).toContain("do NOT create the file");
    expect(out).toContain("leave it absent");
    expect(out).toContain("placeholder");
  });
});

describe("managed frontmatter (system/ files require it)", () => {
  test("adds a description frontmatter to a plain doc and strips it back out", () => {
    const plain = "# Guide\n\nUse bun.";
    const withFm = addManagedFrontmatter(plain, "agents-md");
    expect(withFm.startsWith("---\n")).toBe(true);
    expect(withFm).toContain("description:");
    expect(stripFrontmatter(withFm)).toBe(plain);
  });

  test("leaves an existing description frontmatter untouched", () => {
    const already = "---\ndescription: mine\n---\n# Body\n";
    expect(addManagedFrontmatter(already, "agents-md")).toBe(already);
  });
});

describe("syncTargetIntoMemory", () => {
  test("is a no-op when there is no on-disk content to sync", async () => {
    const target = resolveDreamTarget("./AGENTS.md");
    expect(await syncTargetIntoMemory("agent-x", target, null)).toEqual({
      synced: false,
    });
  });
});

describe("readExistingTarget / writeTarget", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "dream-target-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns null for a missing file, content when present", async () => {
    const target = resolveDreamTarget(join(dir, "AGENTS.md"));
    expect(await readExistingTarget(target)).toBeNull();
    await writeFile(target.path, "hello");
    expect(await readExistingTarget(target)).toBe("hello");
  });

  test("writeTarget creates parent directories", async () => {
    const target = resolveDreamTarget(join(dir, "nested", "deep", "AGENTS.md"));
    await writeTarget(target, "# Guide\n");
    expect(await readExistingTarget(target)).toBe("# Guide\n");
  });
});
