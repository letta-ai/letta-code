import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createReflectionMemoryWorktree,
  finalizeReflectionMemoryWorktree,
  reflectionIntegrationConsumesTranscript,
} from "@/agent/memory-worktree";
import { __testSetBackend } from "@/backend";
import { settingsManager } from "@/settings-manager";

const token = "reflection-test-session";
const authorization = `Basic ${Buffer.from(`letta:${token}`).toString("base64")}`;
const canonicalOrigin = "https://api.letta.com/v1/git/agent-test/state.git";
let root: string;
let memoryDir: string;
let remoteDir: string;
let server: Server;
let proxyUrl: string;
let requests: Array<{ url: string; authorization?: string }>;
let rejectAuth: boolean;
let savedEnv: NodeJS.ProcessEnv;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

beforeEach(async () => {
  savedEnv = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "reflection-http-"));
  memoryDir = join(root, "memory");
  remoteDir = join(root, "remote.git");
  await settingsManager.reset();
  process.env.HOME = root;
  __testSetBackend(null);
  // Isolate user credentials, URL rewrites and signing configuration.
  process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.LETTA_API_KEY = token;
  process.env.LETTA_MEMFS_BASE_URL = "https://api.letta.com";
  delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  delete process.env.GIT_CONFIG_COUNT;
  writeFileSync(
    process.env.GIT_CONFIG_GLOBAL,
    "[commit]\n gpgsign = true\n[gpg]\n program = nonexistent-signing-program\n",
  );
  git(root, ["init", "-b", "main", memoryDir]);
  git(memoryDir, ["config", "core.autocrlf", "false"]);
  writeFileSync(join(memoryDir, "MEMORY.md"), "base\n");
  git(memoryDir, ["add", "MEMORY.md"]);
  git(memoryDir, ["commit", "-m", "initial"]);
  git(root, ["clone", "--bare", memoryDir, remoteDir]);
  git(remoteDir, ["update-server-info"]);
  git(memoryDir, ["remote", "add", "origin", canonicalOrigin]);
  requests = [];
  rejectAuth = false;
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({
      url: url.pathname,
      authorization: request.headers.authorization,
    });
    if (
      rejectAuth ||
      request.headers.authorization !== authorization ||
      !url.pathname.startsWith("/v1/git/agent-test/state.git/")
    ) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
      response.end("unauthorized");
      return;
    }
    // Git's dumb HTTP transport serves a real bare repository. The server
    // replaces only the authenticated proxy, not fetch or integration.
    const path = join(
      remoteDir,
      url.pathname.slice("/v1/git/agent-test/state.git/".length),
    );
    if (!existsSync(path)) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.end(readFileSync(path));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  proxyUrl = `http://127.0.0.1:${address.port}`;
  process.env.LETTA_BASE_URL = proxyUrl;
  process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL = proxyUrl;
  // A broken fetch must fail locally, never contact api.letta.com. The
  // command-scoped /v1/git/ rewrite is more specific than this safety net.
  git(memoryDir, [
    "config",
    `url.${proxyUrl}/bypassed-proxy/.insteadOf`,
    "https://api.letta.com/",
  ]);
  process.env.GIT_TERMINAL_PROMPT = "0";
  process.env.GCM_INTERACTIVE = "never";
  await settingsManager.initialize();
});

afterEach(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await settingsManager.reset();
  __testSetBackend(null);
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
  rmSync(root, { recursive: true, force: true });
});

async function makeReflection() {
  const worktree = await createReflectionMemoryWorktree({
    parentMemoryDir: memoryDir,
  });
  writeFileSync(join(worktree.worktreeDir, "reflection.md"), "learned\n");
  git(worktree.worktreeDir, ["add", "reflection.md"]);
  git(worktree.worktreeDir, ["commit", "-m", "reflection"]);
  // Force integration to create a merge commit; its identity/signing policy
  // must survive switching only the network operation to memory-git.
  writeFileSync(join(memoryDir, "parent.md"), "awake\n");
  git(memoryDir, ["add", "parent.md"]);
  git(memoryDir, ["commit", "-m", "parent"]);
  return worktree;
}

describe("reflection memory HTTP refresh", () => {
  it("fetches through the authenticated Desktop proxy before merging", async () => {
    const worktree = await makeReflection();
    const otherDir = join(root, "other");
    git(root, ["clone", remoteDir, otherDir]);
    writeFileSync(join(otherDir, "remote.md"), "from another environment\n");
    git(otherDir, ["add", "remote.md"]);
    git(otherDir, ["commit", "-m", "remote update"]);
    git(otherDir, ["push", "origin", "main"]);
    git(remoteDir, ["update-server-info"]);
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });
    assert.equal(result.status, "merged", result.error);
    assert.equal(reflectionIntegrationConsumesTranscript(result), true);
    assert.equal(
      readFileSync(join(memoryDir, "reflection.md"), "utf8"),
      "learned\n",
    );
    assert.equal(
      readFileSync(join(memoryDir, "remote.md"), "utf8"),
      "from another environment\n",
    );
    assert.equal(
      git(memoryDir, ["log", "-1", "--format=%an <%ae>"]).trim(),
      "Letta Code <noreply@letta.com>",
    );
    assert.equal(
      git(memoryDir, ["config", "--get", "remote.origin.url"]).trim(),
      canonicalOrigin,
    );
    assert(requests.length > 0);
    assert(
      requests.every(
        (request) =>
          request.url.startsWith("/v1/git/") &&
          request.authorization === authorization,
      ),
    );
    assert.equal(existsSync(worktree.worktreeDir), false);
  });

  it("fails without invoking inherited credential helpers or askpass", async () => {
    const worktree = await makeReflection();
    const marker = join(root, "prompted").replaceAll("\\", "/");
    git(memoryDir, [
      "config",
      "credential.helper",
      `!echo prompted > '${marker}'; exit 1`,
    ]);
    const askpass = join(root, "askpass.sh");
    writeFileSync(askpass, `#!/bin/sh\necho prompted > '${marker}'\nexit 1\n`, {
      mode: 0o755,
    });
    git(memoryDir, ["config", "core.askPass", askpass]);
    process.env.GIT_ASKPASS = askpass;
    process.env.GIT_TERMINAL_PROMPT = "1";
    process.env.GCM_INTERACTIVE = "always";
    rejectAuth = true;
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failurePhase, "integration");
    assert.equal(reflectionIntegrationConsumesTranscript(result), false);
    assert.equal(existsSync(marker), false, "credential UI helper was invoked");
    assert.equal(existsSync(join(memoryDir, "reflection.md")), false);
    assert.equal(existsSync(worktree.worktreeDir), false);
    assert(!result.error?.includes(token));
    assert(!result.error?.includes(authorization));
    assert(requests.length > 0);
    assert(requests.every((request) => request.url.startsWith("/v1/git/")));
  });

  it("authenticates a configured MemFS server without a Desktop proxy", async () => {
    delete process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL;
    process.env.LETTA_MEMFS_BASE_URL = proxyUrl;
    git(memoryDir, [
      "remote",
      "set-url",
      "origin",
      `${proxyUrl}/v1/git/agent-test/state.git`,
    ]);
    const worktree = await makeReflection();
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });
    assert.equal(result.status, "merged", result.error);
    assert(requests.length > 0);
    assert(
      requests.every((request) => request.authorization === authorization),
    );
  });

  it("keeps non-MemFS origins noninteractive without sending the Letta token", async () => {
    git(memoryDir, ["remote", "set-url", "origin", `${proxyUrl}/other.git`]);
    const worktree = await makeReflection();
    const envPath = join(root, "git-env").replaceAll("\\", "/");
    git(memoryDir, [
      "config",
      "credential.helper",
      `!echo "$GCM_INTERACTIVE $GIT_TERMINAL_PROMPT" > '${envPath}'; exit 1`,
    ]);
    process.env.GCM_INTERACTIVE = "always";
    process.env.GIT_TERMINAL_PROMPT = "1";
    const result = await finalizeReflectionMemoryWorktree(worktree, {
      shouldMerge: true,
    });
    assert.equal(result.status, "failed");
    assert.equal(readFileSync(envPath, "utf8").trim(), "never 0");
    assert(requests.length > 0);
    assert(requests.every((request) => !request.authorization));
  });
});
