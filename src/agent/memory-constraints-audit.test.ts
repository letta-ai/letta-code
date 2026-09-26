import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validateMemoryConstraintsHead,
  validateMemoryConstraintsRevision,
} from "./memory-constraints-audit";

describe("committed MemFS constraints audit", () => {
  let repo = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("validates HEAD without reading uncommitted working-tree changes", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-head-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(repo, "persona.md"),
      "---\nname: Persona\ndescription: Identity\n---\nCommitted.\n",
    );
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "valid memory"], { cwd: repo });
    mkdirSync(join(repo, "unindexed"));
    writeFileSync(join(repo, "unindexed", "notes.md"), "working only\n");
    execFileSync("git", ["add", "unindexed/notes.md"], { cwd: repo });

    expect(validateMemoryConstraintsHead(repo)).toEqual({
      valid: true,
      output: "",
    });
    expect(
      execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: repo,
        encoding: "utf8",
      }).trim(),
    ).toBe("unindexed/notes.md");
  });

  test("reports structural and budget failures already committed at HEAD", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-invalid-head-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    mkdirSync(join(repo, "unindexed"));
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(join(repo, "unindexed", "notes.md"), "n".repeat(20_001));
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "invalid memory"], { cwd: repo });

    const result = validateMemoryConstraintsHead(repo);
    expect(result.valid).toBe(false);
    expect(result.output).toStartWith("Memory constraints failed:");
    expect(result.output).not.toContain("staged changes are still present");
    expect(result.output).toContain(
      "unindexed/notes.md: missing required index unindexed/MEMORY.md",
    );
    expect(result.output).toContain(
      "unindexed/notes.md: 20001 characters exceeds 20000",
    );
  });

  test("validates an ancestor against its own constraint config", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-ancestor-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(repo, ".memfs.config.json"),
      `${JSON.stringify({ version: 1, maxCoreMemoryCharacters: 20 })}\n`,
    );
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "initial memory"], { cwd: repo });
    const ancestor = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    writeFileSync(
      join(repo, ".memfs.config.json"),
      `${JSON.stringify({ version: 1, maxCoreMemoryCharacters: 30 })}\n`,
    );
    execFileSync("git", ["add", ".memfs.config.json"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "update limits"], { cwd: repo });

    expect(validateMemoryConstraintsRevision(repo, ancestor)).toEqual({
      valid: true,
      output: "",
    });
  });

  test("keeps the persistent v2 policy when a revision deletes MEMORY.md", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-deleted-root-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(repo, ".git", "letta-memory-layout-policy"),
      "root-marker",
    );
    execFileSync("git", ["add", "MEMORY.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "initial memory"], { cwd: repo });
    execFileSync("git", ["rm", "-q", "MEMORY.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "delete root marker"], { cwd: repo });

    const result = validateMemoryConstraintsHead(repo);
    expect(result.valid).toBe(false);
    expect(result.output).toContain(
      "MEMORY.md: root memory index is required for MemFS v2",
    );
  });

  test("keeps legacy validation before a repository enters v2", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-legacy-audit-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    writeFileSync(
      join(repo, ".git", "letta-memory-layout-policy"),
      "root-marker",
    );
    writeFileSync(join(repo, "system.md"), "legacy memory\n");
    execFileSync("git", ["add", "system.md"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "legacy memory"], { cwd: repo });

    expect(validateMemoryConstraintsHead(repo)).toEqual({
      valid: true,
      output: "",
    });
  });
});
