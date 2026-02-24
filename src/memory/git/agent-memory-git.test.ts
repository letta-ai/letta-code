/**
 * Tests for AgentMemoryGit
 *
 * Run with: bun test src/memory/git/agent-memory-git.test.ts
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMemoryGit } from "./agent-memory-git";

describe("AgentMemoryGit", () => {
  let storageRoot: string;
  let memoryGit: AgentMemoryGit;
  const testAgentId = "test-agent-123";

  beforeEach(async () => {
    // Create temp directory for tests
    storageRoot = join(tmpdir(), `letta-git-test-${Date.now()}`);
    memoryGit = new AgentMemoryGit(storageRoot, testAgentId);
    await memoryGit.init();
  });

  afterEach(() => {
    // Clean up
    if (existsSync(storageRoot)) {
      rmSync(storageRoot, { recursive: true, force: true });
    }
  });

  test("initializes a git repository", async () => {
    const gitDir = join(memoryGit.getRepoPath(), ".git");
    expect(existsSync(gitDir)).toBe(true);
  });

  test("init is idempotent", async () => {
    // Should not throw when called again
    await memoryGit.init();
    await memoryGit.init();
    const history = await memoryGit.log();
    // Should still have exactly one initial commit
    expect(history.length).toBe(1);
    expect(history[0]?.message).toBe("Initial commit");
  });

  test("write and read blocks", async () => {
    await memoryGit.writeBlock(
      "persona",
      "# Persona\nI am a helpful assistant.",
    );
    await memoryGit.writeBlock("human", "# Human\nName: Sarah");

    const persona = await memoryGit.readBlock("persona");
    const human = await memoryGit.readBlock("human");

    expect(persona).toBe("# Persona\nI am a helpful assistant.");
    expect(human).toBe("# Human\nName: Sarah");
  });

  test("read nonexistent block returns null", async () => {
    const content = await memoryGit.readBlock("nonexistent");
    expect(content).toBe(null);
  });

  test("commit creates a new commit", async () => {
    await memoryGit.writeBlock("persona", "# Persona\nVersion 1");
    const sha1 = await memoryGit.commit("Added persona");

    await memoryGit.writeBlock("persona", "# Persona\nVersion 2");
    const sha2 = await memoryGit.commit("Updated persona");

    expect(sha1).not.toBe(sha2);

    const history = await memoryGit.log();
    expect(history.length).toBe(3); // Initial + 2 commits
    expect(history[0]?.message).toBe("Updated persona");
    expect(history[1]?.message).toBe("Added persona");
  });

  test("commit with no changes returns current HEAD", async () => {
    await memoryGit.writeBlock("test", "content");
    const sha1 = await memoryGit.commit("First commit");
    const sha2 = await memoryGit.commit("No changes"); // No actual changes

    expect(sha1).toBe(sha2);
  });

  test("diff shows changes between commits", async () => {
    await memoryGit.writeBlock("persona", "# Persona\nVersion 1");
    const sha1 = await memoryGit.commit("V1");

    await memoryGit.writeBlock("persona", "# Persona\nVersion 2");
    await memoryGit.writeBlock("human", "# Human\nNew block");
    const sha2 = await memoryGit.commit("V2");

    const diffs = await memoryGit.diff(sha1, sha2);

    expect(diffs.length).toBe(2);

    const personaDiff = diffs.find((d) => d.filepath === "persona.md");
    expect(personaDiff?.status).toBe("modified");
    expect(personaDiff?.before).toBe("# Persona\nVersion 1");
    expect(personaDiff?.after).toBe("# Persona\nVersion 2");

    const humanDiff = diffs.find((d) => d.filepath === "human.md");
    expect(humanDiff?.status).toBe("added");
    expect(humanDiff?.before).toBe(null);
    expect(humanDiff?.after).toBe("# Human\nNew block");
  });

  test("checkout reverts to previous state", async () => {
    await memoryGit.writeBlock("persona", "# Persona\nVersion 1");
    const sha1 = await memoryGit.commit("V1");

    await memoryGit.writeBlock("persona", "# Persona\nVersion 2");
    await memoryGit.commit("V2");

    // Verify current state
    expect(await memoryGit.readBlock("persona")).toBe("# Persona\nVersion 2");

    // Checkout previous commit
    await memoryGit.checkout(sha1);

    // Verify rolled back
    expect(await memoryGit.readBlock("persona")).toBe("# Persona\nVersion 1");
  });

  test("list blocks returns all memory files", async () => {
    await memoryGit.writeBlock("persona", "content");
    await memoryGit.writeBlock("human", "content");
    await memoryGit.writeBlock("project", "content");
    await memoryGit.commit("Add blocks");

    const blocks = await memoryGit.listBlocks();

    expect(blocks).toContain("persona");
    expect(blocks).toContain("human");
    expect(blocks).toContain("project");
  });

  test("delete block removes file", async () => {
    // First create and commit the file
    await memoryGit.writeBlock("temp", "content");
    expect(await memoryGit.readBlock("temp")).toBe("content");
    await memoryGit.commit("Added temp block");

    // Now delete it
    await memoryGit.deleteBlock("temp");
    expect(await memoryGit.readBlock("temp")).toBe(null);

    // Commit the deletion
    await memoryGit.commit("Deleted temp block");

    const history = await memoryGit.log();
    expect(history[0]?.message).toBe("Deleted temp block");

    // Verify the deletion is in the diff
    const diff = await memoryGit.diff(
      history[1]?.sha ?? "",
      history[0]?.sha ?? "",
    );
    expect(diff.length).toBe(1);
    expect(diff[0]?.status).toBe("deleted");
    expect(diff[0]?.filepath).toBe("temp.md");
  });

  test("handles nested labels (subdirectories)", async () => {
    await memoryGit.writeBlock("project/notes", "# Project Notes");
    await memoryGit.writeBlock("project/todos", "# Project TODOs");
    await memoryGit.commit("Add nested blocks");

    const notes = await memoryGit.readBlock("project/notes");
    const todos = await memoryGit.readBlock("project/todos");

    expect(notes).toBe("# Project Notes");
    expect(todos).toBe("# Project TODOs");

    const blocks = await memoryGit.listBlocks();
    expect(blocks).toContain("project/notes");
    expect(blocks).toContain("project/todos");
  });

  test("branch operations", async () => {
    await memoryGit.writeBlock("test", "main content");
    await memoryGit.commit("Main commit");

    // Create and list branches
    await memoryGit.createBranch("feature");
    const branches = await memoryGit.listBranches();
    expect(branches).toContain("main");
    expect(branches).toContain("feature");

    // Check current branch
    const current = await memoryGit.currentBranch();
    expect(current).toBe("main");
  });

  test("readBlockAt reads file at specific commit", async () => {
    await memoryGit.writeBlock("persona", "# Version 1");
    const sha1 = await memoryGit.commit("V1");

    await memoryGit.writeBlock("persona", "# Version 2");
    const sha2 = await memoryGit.commit("V2");

    // Read current (V2)
    expect(await memoryGit.readBlock("persona")).toBe("# Version 2");

    // Read at V1
    expect(await memoryGit.readBlockAt("persona", sha1)).toBe("# Version 1");

    // Read at V2
    expect(await memoryGit.readBlockAt("persona", sha2)).toBe("# Version 2");
  });

  test("log returns commit history", async () => {
    await memoryGit.writeBlock("test", "v1");
    await memoryGit.commit("Commit 1", "Agent Alpha");

    await memoryGit.writeBlock("test", "v2");
    await memoryGit.commit("Commit 2", "Agent Beta");

    const history = await memoryGit.log();

    expect(history.length).toBe(3); // Initial + 2

    expect(history[0]?.message).toBe("Commit 2");
    expect(history[0]?.author).toBe("Agent Beta");

    expect(history[1]?.message).toBe("Commit 1");
    expect(history[1]?.author).toBe("Agent Alpha");

    expect(history[2]?.message).toBe("Initial commit");
    expect(history[2]?.author).toBe("Letta");

    // Timestamps should be recent
    const now = Date.now();
    for (const commit of history) {
      expect(commit.timestamp.getTime()).toBeLessThanOrEqual(now);
      expect(commit.timestamp.getTime()).toBeGreaterThan(now - 60000); // Within last minute
    }
  });
});
