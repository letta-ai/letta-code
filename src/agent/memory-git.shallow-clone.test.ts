import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cloneMemoryRepo,
  getMemoryRepoDir,
  pullMemory,
  syncPendingMemoryCommitsAfterTurn,
} from "@/agent/memory-git";
import { __testOverrideGetClient } from "@/backend/api/client";

const ENV_KEYS = [
  "LETTA_CONFIG_DIR",
  "LETTA_MEMFS_BASE_URL",
  "LETTA_MEMFS_GIT_PROXY_BASE_URL",
  "LETTA_API_KEY",
] as const;
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

let root = "";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(repo: string, file: string, content: string): string {
  writeFileSync(join(repo, file), content);
  git(repo, "add", file);
  git(repo, "commit", "--no-verify", "-m", file);
  return git(repo, "rev-parse", "HEAD");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "memory-git-shallow-"));
  process.env.LETTA_CONFIG_DIR = join(root, "config");
  // file:// (not a bare path) so git honors --depth like it does over HTTP.
  process.env.LETTA_MEMFS_BASE_URL = `file://${join(root, "server")}`;
  delete process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL;
  process.env.LETTA_API_KEY = "test-token";
  __testOverrideGetClient(async () => ({ apiKey: "test-token" }));
});

afterEach(() => {
  __testOverrideGetClient(null);
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("hosted memory repo shallow clone", () => {
  test("clones only the tip and keeps sync and reset recovery working", async () => {
    const agentId = "agent-shallow-test";
    const remote = join(root, "server", "v1", "git", agentId, "state.git");
    mkdirSync(remote, { recursive: true });
    git(remote, "init", "--bare", "-b", "main");

    const writer = join(root, "writer");
    execFileSync("git", ["clone", "-q", remote, writer]);
    git(writer, "config", "user.name", "Writer");
    git(writer, "config", "user.email", "writer@example.com");
    for (const n of [1, 2, 3]) commit(writer, `old-${n}.md`, `old ${n}\n`);
    git(writer, "push", "-q", "origin", "main");

    // Fresh clone is shallow: one commit, full tree.
    await cloneMemoryRepo(agentId);
    const memoryDir = getMemoryRepoDir(agentId);
    expect(git(memoryDir, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(memoryDir, "rev-list", "--count", "HEAD")).toBe("1");
    expect(existsSync(join(memoryDir, "old-1.md"))).toBe(true);

    // Remote advances while the agent commits locally: rebase + push works.
    const remoteSha = commit(writer, "remote.md", "remote\n");
    git(writer, "push", "-q", "origin", "main");
    const localSha = commit(memoryDir, "local.md", "local\n");

    const synced = await syncPendingMemoryCommitsAfterTurn(agentId, {
      memoryDir,
    });
    expect(synced.status).toBe("pushed");
    const remoteHead = git(remote, "rev-parse", "main");
    expect(git(remote, "rev-parse", `${remoteHead}~1`)).toBe(remoteSha);
    expect(git(remote, "rev-list", "--count", "main")).toBe("5");
    expect(git(remote, "show", `${remoteHead}:local.md`)).toBe("local");
    expect(remoteHead).not.toBe(localSha); // rebased onto the remote commit

    // Remote history is rewritten: reset-to-remote recovery still works.
    git(writer, "checkout", "-q", "--orphan", "rewritten");
    git(writer, "rm", "-rqf", ".");
    const rewrittenSha = commit(writer, "fresh.md", "fresh\n");
    git(writer, "push", "-q", "-f", "origin", "rewritten:main");

    const pulled = await pullMemory(agentId);
    expect(pulled.summary).toContain("Recovered memory repo by resetting");
    expect(git(memoryDir, "rev-parse", "HEAD")).toBe(rewrittenSha);
    expect(existsSync(join(memoryDir, "fresh.md"))).toBe(true);
    expect(existsSync(join(memoryDir, "local.md"))).toBe(false);
    expect(git(memoryDir, "for-each-ref", "refs/letta-backup")).toContain(
      remoteHead,
    );
  });
});
