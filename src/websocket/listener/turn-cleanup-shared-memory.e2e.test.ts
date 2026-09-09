import { afterAll, afterEach, beforeAll, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getRepositoryMountDir } from "@/agent/memory-git";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { runListenerTurnCleanup } from "./turn-cleanup";

const AGENT_ID = `agent-shared-memory-post-turn-e2e-${randomUUID()}`;
const REPOSITORY_NAME = "shared-notes";
const originalFetch = globalThis.fetch;
const originalMemfsBaseUrl = process.env.LETTA_MEMFS_BASE_URL;
const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureIdentity(repo: string): void {
  git(repo, ["config", "user.name", "Shared Memory E2E"]);
  git(repo, ["config", "user.email", "shared-memory-e2e@letta.com"]);
}

beforeAll(async () => {
  await settingsManager.initialize();
  globalThis.fetch = mock(async (input) => {
    const url = String(input);
    if (url.includes(`/v1/agents/${AGENT_ID}/repositories`)) {
      return Response.json({
        repositories: [
          {
            id: "repo-shared-notes",
            name: REPOSITORY_NAME,
            is_primary: false,
            permissions: "read_write",
          },
        ],
      });
    }
    throw new Error(`Unexpected fetch in shared-memory E2E: ${url}`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  if (originalMemfsBaseUrl === undefined) {
    delete process.env.LETTA_MEMFS_BASE_URL;
  } else {
    process.env.LETTA_MEMFS_BASE_URL = originalMemfsBaseUrl;
  }
  __testSetBackend(null);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await settingsManager.reset();
});

test("completed listener turn cleanup pushes an attached shared-memory commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "shared-memory-post-turn-e2e-"));
  tempDirs.push(root);
  const remote = join(root, "remote.git");
  const seed = join(root, "seed");
  const mount = getRepositoryMountDir(AGENT_ID, REPOSITORY_NAME);
  tempDirs.push(dirname(mount));

  mkdirSync(seed, { recursive: true });
  git(root, ["init", "--bare", remote]);
  git(seed, ["init", "--initial-branch=main"]);
  configureIdentity(seed);
  writeFileSync(join(seed, "MEMORY.md"), "# Shared memory\n", "utf8");
  git(seed, ["add", "MEMORY.md"]);
  git(seed, ["commit", "-m", "initialize shared memory"]);
  git(seed, ["remote", "add", "origin", remote]);
  git(seed, ["push", "-u", "origin", "main"]);
  git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  mkdirSync(join(mount, ".."), { recursive: true });
  git(root, ["clone", remote, mount]);
  configureIdentity(mount);
  writeFileSync(
    join(mount, "turn-note.md"),
    "committed during the turn\n",
    "utf8",
  );
  git(mount, ["add", "turn-note.md"]);
  git(mount, ["commit", "-m", "record completed turn"]);
  const localSha = git(mount, ["rev-parse", "HEAD"]);
  const remoteShaBefore = git(remote, ["rev-parse", "main"]);

  __testSetBackend({
    capabilities: {
      remoteMemfs: true,
      localMemfs: false,
    },
  } as unknown as Backend);
  process.env.LETTA_MEMFS_BASE_URL = root;
  git(mount, [
    "remote",
    "set-url",
    "origin",
    join(root, "v1", "git", AGENT_ID, "repositories", `${REPOSITORY_NAME}.git`),
  ]);
  mkdirSync(join(root, "v1", "git", AGENT_ID, "repositories"), {
    recursive: true,
  });
  git(root, [
    "clone",
    "--bare",
    remote,
    join(root, "v1", "git", AGENT_ID, "repositories", `${REPOSITORY_NAME}.git`),
  ]);

  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, AGENT_ID, "conv-e2e");
  await runListenerTurnCleanup({
    runtime,
    agentId: AGENT_ID,
    normalizedAgentId: AGENT_ID,
    conversationId: "conv-e2e",
    finalized: true,
  });

  const postTurnRemote = join(
    root,
    "v1",
    "git",
    AGENT_ID,
    "repositories",
    `${REPOSITORY_NAME}.git`,
  );
  expect(remoteShaBefore).not.toBe(localSha);
  expect(git(postTurnRemote, ["rev-parse", "main"])).toBe(localSha);
  expect(git(mount, ["rev-list", "--count", "@{u}..HEAD"])).toBe("0");
});
