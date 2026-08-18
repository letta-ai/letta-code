import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPreCommitHook,
  readMemoryFormatMarker,
} from "./memory-git-hooks";

describe("MemFS v2 pre-commit hook", () => {
  let repo = "";

  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("validates the projected tree while ignoring skills and silent directories", () => {
    repo = mkdtempSync(join(tmpdir(), "memfs-v2-hook-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test Agent"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], {
      cwd: repo,
    });
    installPreCommitHook(repo, "memfs-v2");
    expect(readMemoryFormatMarker(repo)).toBe("memfs-v2");

    mkdirSync(join(repo, "silent"));
    mkdirSync(join(repo, "skills", "demo"), { recursive: true });
    writeFileSync(join(repo, "MEMORY.md"), "# Memory\n");
    writeFileSync(
      join(repo, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\n---\nPersistent.\n',
    );
    writeFileSync(join(repo, "silent", "notes.md"), "Not projected.\n");
    writeFileSync(join(repo, "skills", "demo", "SKILL.md"), "Skill format.\n");
    execFileSync(
      "git",
      ["add", "MEMORY.md", "persona.md", "silent", "skills"],
      {
        cwd: repo,
      },
    );
    execFileSync("git", ["commit", "-qm", "valid v2 memory"], { cwd: repo });

    writeFileSync(
      join(repo, "silent", "MEMORY.md"),
      "# Silent is now memory\n",
    );
    execFileSync("git", ["add", "silent/MEMORY.md"], { cwd: repo });
    const activatedDirectory = spawnSync(
      "git",
      ["commit", "-m", "activate silent directory"],
      { cwd: repo, encoding: "utf8" },
    );
    expect(activatedDirectory.status).not.toBe(0);
    expect(activatedDirectory.stdout + activatedDirectory.stderr).toContain(
      "silent/notes.md: missing frontmatter",
    );

    execFileSync("git", ["reset", "--hard", "HEAD"], { cwd: repo });
    writeFileSync(
      join(repo, "persona.md"),
      '---\nname: "Persona"\ndescription: "Identity"\nextra: "no"\n---\nPersistent.\n',
    );
    execFileSync("git", ["add", "persona.md"], { cwd: repo });
    const extraKey = spawnSync("git", ["commit", "-m", "invalid frontmatter"], {
      cwd: repo,
      encoding: "utf8",
    });
    expect(extraKey.status).not.toBe(0);
    expect(extraKey.stdout + extraKey.stderr).toContain(
      "unknown frontmatter key 'extra' (allowed: name description)",
    );
  });
});
