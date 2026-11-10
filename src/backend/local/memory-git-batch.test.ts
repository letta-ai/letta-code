import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { readCommittedFiles } from "./memory-git-batch";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "memfs-batch-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "agent-local-test@letta.com"]);
  git(repo, ["config", "user.name", "Local Test"]);
  return repo;
}

function commit(repo: string, files: Record<string, string>): void {
  for (const [relativePath, contents] of Object.entries(files)) {
    const fullPath = join(repo, relativePath);
    mkdirSync(join(fullPath, ".."), { recursive: true });
    writeFileSync(fullPath, contents, "utf8");
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "memory"]);
}

describe("readCommittedFiles", () => {
  test("reads committed file contents in one batch", () => {
    const repo = initRepo();
    try {
      commit(repo, {
        "system/persona.md": "---\ndescription: Persona\n---\nI am local.\n",
        "system/notes.md": "---\ndescription: Notes\n---\nUse Bun.\n",
        "reference/details.md": "plain reference\n",
      });

      const contents = readCommittedFiles(repo, [
        "system/persona.md",
        "system/notes.md",
        "reference/details.md",
      ]);

      expect(contents.get("system/persona.md")).toContain("I am local.");
      expect(contents.get("system/notes.md")).toContain("Use Bun.");
      expect(contents.get("reference/details.md")).toBe("plain reference\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("preserves file bytes exactly, including trailing newlines", () => {
    const repo = initRepo();
    try {
      commit(repo, {
        "no-newline.md": "no trailing newline",
        "with-newline.md": "with trailing newline\n",
        "crlf.md": "first\r\nsecond\r\n",
      });

      const contents = readCommittedFiles(repo, [
        "no-newline.md",
        "with-newline.md",
        "crlf.md",
      ]);

      expect(contents.get("no-newline.md")).toBe("no trailing newline");
      expect(contents.get("with-newline.md")).toBe("with trailing newline\n");
      expect(contents.get("crlf.md")).toBe("first\r\nsecond\r\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("marks paths that are not in the committed tree as unreadable", () => {
    const repo = initRepo();
    try {
      commit(repo, { "known.md": "known\n" });

      const contents = readCommittedFiles(repo, ["known.md", "missing.md"]);

      expect(contents.get("known.md")).toBe("known\n");
      expect(contents.get("missing.md")).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("drops files that are too large to read, like the previous per-file read", () => {
    const repo = initRepo();
    try {
      commit(repo, {
        "small.md": "small\n",
        "huge.md": "x".repeat(1024 * 1024 + 1),
      });

      const contents = readCommittedFiles(repo, ["small.md", "huge.md"]);

      expect(contents.get("small.md")).toBe("small\n");
      expect(contents.get("huge.md")).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("keeps reading later files after a gitlink entry", () => {
    const repo = initRepo();
    try {
      commit(repo, { "top.md": "top\n" });
      // A gitlink resolves to a commit object, which is a different record
      // shape than a blob and must not desync the parser for the files
      // that follow it.
      git(repo, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${git(repo, ["rev-parse", "HEAD"]).trim()},link.md`,
      ]);
      git(repo, ["commit", "-m", "add link"]);

      const contents = readCommittedFiles(repo, ["link.md", "top.md"]);

      expect(contents.get("link.md")).toContain("commit ");
      expect(contents.get("top.md")).toBe("top\n");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("spawns a single git process for many files", () => {
    const repo = initRepo();
    const binDir = mkdtempSync(join(tmpdir(), "memfs-batch-shim-"));
    const counterPath = join(binDir, "git-calls.log");
    const originalPath = process.env.PATH;
    try {
      commit(repo, {
        "system/persona.md": "persona\n",
        "system/a.md": "a\n",
        "system/b.md": "b\n",
        "system/c.md": "c\n",
        "system/d.md": "d\n",
        "system/e.md": "e\n",
      });

      const realGit = execFileSync("which", ["git"], {
        encoding: "utf8",
      }).trim();
      const shimPath = join(binDir, "git");
      writeFileSync(
        shimPath,
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${counterPath}"\nexec "${realGit}" "$@"\n`,
        "utf8",
      );
      chmodSync(shimPath, 0o755);
      process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;

      const contents = readCommittedFiles(repo, [
        "system/persona.md",
        "system/a.md",
        "system/b.md",
        "system/c.md",
        "system/d.md",
        "system/e.md",
      ]);

      expect(contents.get("system/e.md")).toBe("e\n");
      const calls = execFileSync("cat", [counterPath], { encoding: "utf8" })
        .split("\n")
        .filter((line) => line.length > 0);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toBe("cat-file --batch");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(binDir, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
