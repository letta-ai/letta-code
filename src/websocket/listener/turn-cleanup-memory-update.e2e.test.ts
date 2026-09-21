import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { runListenerTurnCleanup } from "./turn-cleanup";

const root = mkdtempSync(join(tmpdir(), "memory-update-e2e-"));
const originalEnv = {
  HOME: process.env.HOME,
  LETTA_API_KEY: process.env.LETTA_API_KEY,
  LETTA_MEMFS_BASE_URL: process.env.LETTA_MEMFS_BASE_URL,
};
const originalFetch = globalThis.fetch;

function git(cwd: string, args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=Memory test",
      "-c",
      "user.email=test@example.com",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();
}

beforeAll(async () => {
  process.env.HOME = root;
  process.env.LETTA_API_KEY = "memory-update-test-token";
  process.env.LETTA_MEMFS_BASE_URL = root;
  await settingsManager.reset();
  await settingsManager.initialize();
  __testSetBackend({
    capabilities: { remoteMemfs: true, localMemfs: false },
  } as unknown as Backend);
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith("/repositories")) {
      return Response.json({ repositories: [] });
    }
    throw new Error(`Unexpected fetch: ${String(input)}`);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  __testSetBackend(null);
  await settingsManager.reset();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function setupAgent() {
  const agentId = `agent-${crypto.randomUUID()}`;
  const remote = join(root, "v1", "git", agentId, "state.git");
  const memoryDir = getScopedMemoryFilesystemRoot(agentId);
  mkdirSync(dirname(remote), { recursive: true });
  mkdirSync(memoryDir, { recursive: true });
  git(root, ["init", "--bare", remote]);
  git(memoryDir, ["init", "--initial-branch=main"]);
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
  git(memoryDir, ["add", "MEMORY.md"]);
  git(memoryDir, ["commit", "-m", "Initialize"]);
  git(memoryDir, ["remote", "add", "origin", remote]);
  git(memoryDir, ["push", "-u", "origin", "main"]);
  settingsManager.setMemfsEnabled(agentId, true);

  const updates: { message: Record<string, unknown>; remoteSha: string }[] = [];
  const listener = createRuntime();
  listener.transport = {
    kind: "runtime",
    bufferedAmount: 0,
    isOpen: () => true,
    send: (payload: string) => {
      const message = JSON.parse(payload);
      if (message.type === "memory_updated") {
        updates.push({
          message,
          remoteSha: git(remote, ["rev-parse", "main"]),
        });
      }
    },
  };
  const runtime = getOrCreateScopedRuntime(listener, agentId, "conv-picture");
  const cleanup = (finalized = true) =>
    runListenerTurnCleanup({
      runtime,
      agentId,
      normalizedAgentId: agentId,
      conversationId: "conv-picture",
      finalized,
    });
  const commitPicture = () => {
    // A direct file write + commit, with no memory tool or upload command.
    writeFileSync(join(memoryDir, "profile.png"), Buffer.from("picture bytes"));
    git(memoryDir, ["add", "profile.png"]);
    git(memoryDir, ["commit", "-m", "Change profile picture"]);
    return git(memoryDir, ["rev-parse", "HEAD"]);
  };
  return { remote, memoryDir, agentId, updates, cleanup, commitPicture };
}

test("a direct profile picture commit notifies its conversation after the push", async () => {
  const { remote, agentId, updates, cleanup, commitPicture } = setupAgent();
  const sha = commitPicture();
  expect(git(remote, ["rev-parse", "main"])).not.toBe(sha);
  expect(updates).toEqual([]);

  await cleanup();

  expect(updates).toEqual([
    {
      remoteSha: sha,
      message: expect.objectContaining({
        type: "memory_updated",
        affected_paths: ["*"],
        runtime: { agent_id: agentId, conversation_id: "conv-picture" },
        timestamp: expect.any(Number),
      }),
    },
  ]);

  await cleanup();
  expect(updates).toHaveLength(1);
});

test("a rejected push does not tell the UI that memory changed", async () => {
  const { remote, updates, cleanup, commitPicture } = setupAgent();
  const oldSha = git(remote, ["rev-parse", "main"]);
  commitPicture();
  writeFileSync(join(remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", {
    mode: 0o755,
  });

  await cleanup();

  expect(git(remote, ["rev-parse", "main"])).toBe(oldSha);
  expect(updates).toEqual([]);
});

test("an unfinished turn neither pushes nor notifies", async () => {
  const { remote, updates, cleanup, commitPicture } = setupAgent();
  const oldSha = git(remote, ["rev-parse", "main"]);
  commitPicture();

  await cleanup(false);

  expect(git(remote, ["rev-parse", "main"])).toBe(oldSha);
  expect(updates).toEqual([]);
});
