import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTargetInstruction,
  readExistingTarget,
  resolveDreamTarget,
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
  test("agents-md includes the standard guidance and the file name", () => {
    const target = resolveDreamTarget("./AGENTS.md");
    const out = buildTargetInstruction(target, "# Existing\nrules");
    expect(out).toContain("$MEMORY_DIR/AGENTS.md");
    expect(out).toContain("agents.md");
    expect(out).toContain("COMMANDS");
    expect(out).toContain("edit in place");
    expect(out).toContain("# Existing\nrules");
  });

  test("generic uses generic guidance, not the agents.md standard text", () => {
    const target = resolveDreamTarget("./memory.md");
    const out = buildTargetInstruction(target, null);
    expect(out).toContain("$MEMORY_DIR/memory.md");
    expect(out).not.toContain("agents.md");
    expect(out).toContain("does not exist yet — create it");
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
