import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitMemoryWriterProposal,
  createMemoryWriterWorktree,
  integrateMemoryWriterWorktree,
} from "@/agent/memory-writer-worktree";

let tempDir: string;
let memoryDir: string;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@test.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@test.com",
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: GIT_ENV,
    encoding: "utf-8",
  });
}

function writeMemoryFile(relativePath: string, content: string): void {
  writeFileSync(join(memoryDir, relativePath), content, "utf-8");
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "memory-writer-worktree-"));
  memoryDir = join(tempDir, "agent", "memory");
  mkdirSync(join(tempDir, "agent"), { recursive: true });
  rmSync(memoryDir, { recursive: true, force: true });
  git(tempDir, ["init", "-b", "main", memoryDir]);
  git(memoryDir, ["config", "core.autocrlf", "false"]);
  git(memoryDir, ["config", "core.eol", "lf"]);
  writeMemoryFile("persona.md", "---\ndescription: Persona\n---\nbase\n");
  git(memoryDir, ["add", "persona.md"]);
  git(memoryDir, ["commit", "-m", "init"]);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("memory-writer worktrees", () => {
  test("fast-forwards a clean proposal onto parent main", async () => {
    const worktree = await createMemoryWriterWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "human.md"),
      "---\ndescription: Human\n---\nprefers bun\n",
      "utf-8",
    );

    const committed = await commitMemoryWriterProposal({
      worktree,
      author: {
        agentId: "agent-parent",
        authorName: "Parent",
        authorEmail: "agent-parent@letta.com",
      },
      jobId: "job-apply",
      reason: "Remember bun preference",
    });
    expect(committed.committed).toBe(true);

    const result = await integrateMemoryWriterWorktree({
      worktree,
      shouldIntegrate: true,
    });

    expect(result.status).toBe("applied");
    expect(readFileSync(join(memoryDir, "human.md"), "utf-8")).toContain(
      "prefers bun",
    );
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(existsSync(worktree.worktreeDir)).toBe(false);
    expect(
      git(memoryDir, ["log", "-1", "--pretty=%B"]).includes(
        "Memory-Job-ID: job-apply",
      ),
    ).toBe(true);
    expect(git(memoryDir, ["log", "-1", "--pretty=%an"]).trim()).toBe("Parent");
  });

  test("preserves the proposal when parent has a conflicting edit", async () => {
    const worktree = await createMemoryWriterWorktree({
      parentMemoryDir: memoryDir,
    });
    writeFileSync(
      join(worktree.worktreeDir, "persona.md"),
      "---\ndescription: Persona\n---\nwriter\n",
      "utf-8",
    );
    await commitMemoryWriterProposal({
      worktree,
      author: {
        agentId: "agent-parent",
        authorName: "Parent",
        authorEmail: "agent-parent@letta.com",
      },
      jobId: "job-conflict",
      reason: "Writer persona",
    });

    writeMemoryFile("persona.md", "---\ndescription: Persona\n---\nparent\n");
    git(memoryDir, ["add", "persona.md"]);
    git(memoryDir, ["commit", "-m", "parent"]);

    const result = await integrateMemoryWriterWorktree({
      worktree,
      shouldIntegrate: true,
    });

    expect(result.status).toBe("needs_review");
    expect(result.patch).toBeTruthy();
    expect(git(memoryDir, ["status", "--porcelain"]).trim()).toBe("");
    expect(readFileSync(join(memoryDir, "persona.md"), "utf-8")).toContain(
      "parent",
    );
    expect(
      git(memoryDir, ["branch", "--list", worktree.branchName]).trim(),
    ).toContain(worktree.branchName);
  });

  test("reports noop when the writer made no commits", async () => {
    const worktree = await createMemoryWriterWorktree({
      parentMemoryDir: memoryDir,
    });
    const result = await integrateMemoryWriterWorktree({
      worktree,
      shouldIntegrate: true,
    });
    expect(result.status).toBe("noop");
    expect(existsSync(worktree.worktreeDir)).toBe(false);
  });
});
