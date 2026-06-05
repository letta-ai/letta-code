import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWithRuntimeContext } from "@/runtime-context";

const execFile = promisify(execFileCb);

const TEST_AGENT_ID = "agent-test-memory-tool";
const TEST_AGENT_NAME = "Bob";

let mockClientOverride: (() => Promise<unknown>) | null = null;

async function getMockClient() {
  if (mockClientOverride) {
    return mockClientOverride();
  }

  return {
    _options: { apiKey: process.env.LETTA_API_KEY ?? "" },
    agents: {
      retrieve: mock(() => Promise.resolve({ name: TEST_AGENT_NAME })),
    },
  };
}

function getMockMemfsServerUrl(): string {
  return process.env.LETTA_MEMFS_BASE_URL || "https://api.letta.com";
}

function isMockLocalhostUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function getMockMemfsGitProxyRewriteConfig() {
  const rawProxyBaseUrl = process.env.LETTA_MEMFS_GIT_PROXY_BASE_URL?.trim();
  if (!rawProxyBaseUrl || !isMockLocalhostUrl(rawProxyBaseUrl)) {
    return null;
  }

  const memfsBaseUrl = getMockMemfsServerUrl().trim().replace(/\/+$/, "");
  if (!memfsBaseUrl.includes("api.letta.com")) {
    return null;
  }

  const proxyBaseUrl = rawProxyBaseUrl.replace(/\/+$/, "");
  const proxyPrefix = `${proxyBaseUrl}/v1/git/`;
  const memfsPrefix = `${memfsBaseUrl}/v1/git/`;
  return {
    proxyBaseUrl,
    memfsBaseUrl,
    proxyPrefix,
    memfsPrefix,
    configKey: `url.${proxyPrefix}.insteadOf`,
    configValue: memfsPrefix,
  };
}

mock.module("../backend/api/client", () => ({
  __testOverrideGetClient: (factory: (() => Promise<unknown>) | null) => {
    mockClientOverride = factory;
  },
  getClient: mock(getMockClient),
  LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV: "LETTA_MEMFS_GIT_PROXY_BASE_URL",
  getMemfsGitProxyRewriteConfig: getMockMemfsGitProxyRewriteConfig,
  getMemfsServerUrl: getMockMemfsServerUrl,
  getServerUrl: () => "http://localhost:8283",
}));

const { memory } = await import("@/tools/impl/memory");

function runScopedMemory(args: Parameters<typeof memory>[0]) {
  return runWithRuntimeContext({ agentId: TEST_AGENT_ID }, () => memory(args));
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return String(stdout ?? "").trim();
}

async function cloneRemoteRepo(
  remoteDir: string,
  cloneDir: string,
): Promise<void> {
  await execFile("git", ["clone", "--branch", "main", remoteDir, cloneDir]);
  await runGit(cloneDir, ["config", "user.name", "remote-user"]);
  await runGit(cloneDir, ["config", "user.email", "remote-user@example.com"]);
}

async function initTrackedMemoryRepo(
  repoDir: string,
  remoteDir: string,
): Promise<void> {
  await execFile("git", ["init", "--bare", remoteDir]);
  await execFile("git", ["init", "-b", "main", repoDir]);
  await runGit(repoDir, ["config", "user.name", "setup"]);
  await runGit(repoDir, ["config", "user.email", "setup@example.com"]);
  await runGit(repoDir, ["remote", "add", "origin", remoteDir]);

  writeFileSync(join(repoDir, ".gitkeep"), "", "utf8");
  await runGit(repoDir, ["add", ".gitkeep"]);
  await runGit(repoDir, ["commit", "-m", "initial"]);
  await runGit(repoDir, ["push", "-u", "origin", "main"]);
}

describe("memory tool", () => {
  let tempRoot: string;
  let memoryDir: string;
  let remoteDir: string;

  // Deliberately avoid mock.module("../../agent/context") here so this suite
  // doesn't leak agent identity into unrelated tests through Bun's shared
  // module graph.

  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalAgentId = process.env.AGENT_ID;
  const originalAgentName = process.env.AGENT_NAME;
  const originalHome = process.env.HOME;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-memory-tool-"));
    memoryDir = join(tempRoot, ".letta", "agents", TEST_AGENT_ID, "memory");
    remoteDir = join(tempRoot, "remote.git");

    await initTrackedMemoryRepo(memoryDir, remoteDir);

    process.env.HOME = tempRoot;
    process.env.MEMORY_DIR = memoryDir;
    process.env.AGENT_ID = TEST_AGENT_ID;
    process.env.AGENT_NAME = TEST_AGENT_NAME;
  });

  afterEach(async () => {
    if (originalMemoryDir === undefined) delete process.env.MEMORY_DIR;
    else process.env.MEMORY_DIR = originalMemoryDir;

    if (originalAgentId === undefined) delete process.env.AGENT_ID;
    else process.env.AGENT_ID = originalAgentId;

    if (originalAgentName === undefined) delete process.env.AGENT_NAME;
    else process.env.AGENT_NAME = originalAgentName;

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    mock.restore();
  });

  test("requires reason", async () => {
    await expect(
      runScopedMemory({
        command: "create",
        file_path: "system/test.md",
        description: "test desc",
      } as Parameters<typeof memory>[0]),
    ).rejects.toThrow(/missing required parameter/i);
  });

  test("uses reason as commit message and agent identity as commit author", async () => {
    const reason = "Create coding preferences block";

    await runScopedMemory({
      command: "create",
      reason,
      file_path: "system/human/prefs/coding.md",
      description: "The user's coding preferences.",
      file_text: "The user likes explicit types.",
    });

    const logOutput = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%s%n%an%n%ae",
    ]);
    const [subject, authorName, authorEmail] = logOutput.split("\n");

    expect(subject).toBe(reason);
    expect(authorName).toBe(TEST_AGENT_NAME);
    expect(authorEmail).toBe(`${TEST_AGENT_ID}@letta.com`);

    const remoteSubject = await execFile(
      "git",
      ["--git-dir", remoteDir, "log", "-1", "--pretty=format:%s", "main"],
      {},
    ).then((r) => String(r.stdout ?? "").trim());
    expect(remoteSubject).toBe("initial");

    const aheadCount = await runGit(memoryDir, [
      "rev-list",
      "--count",
      "@{u}..HEAD",
    ]);
    expect(aheadCount).toBe("1");
  });

  test("prefers scoped agent memory over stale MEMORY_DIR env", async () => {
    const scopedMemoryDir = memoryDir;
    const staleMemoryDir = join(tempRoot, "stale-memory");
    const scopedRemoteDir = join(tempRoot, "scoped-remote.git");

    await initTrackedMemoryRepo(staleMemoryDir, scopedRemoteDir);
    process.env.MEMORY_DIR = staleMemoryDir;

    await runScopedMemory({
      command: "create",
      reason: "Create scoped memory file",
      file_path: "system/scoped.md",
      description: "Scoped file",
      file_text: "scoped body",
    });

    const scopedContent = await runGit(scopedMemoryDir, [
      "show",
      "HEAD:system/scoped.md",
    ]);
    expect(scopedContent).toContain("scoped body");

    const staleStatus = await runGit(staleMemoryDir, ["status", "--short"]);
    expect(staleStatus).not.toContain("scoped.md");
  });

  test("commits without pushing even when remote is unavailable", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Seed notes",
      file_path: "reference/history/notes.md",
      description: "Notes block",
      file_text: "old value",
    });

    await runGit(memoryDir, [
      "remote",
      "set-url",
      "origin",
      join(tempRoot, "missing-remote.git"),
    ]);

    const reason = "Update notes after remote failure";
    const result = await runScopedMemory({
      command: "str_replace",
      reason,
      file_path: "reference/history/notes.md",
      old_string: "old value",
      new_string: "new value",
    });

    expect(result.message).toContain("harness will sync after the turn");

    const subject = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%s",
    ]);
    expect(subject).toBe(reason);
  });

  test("commits local changes when remote memory has advanced", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Seed diverged notes",
      file_path: "reference/history/notes.md",
      description: "Notes block",
      file_text: "old value\nlocal line",
    });

    const remoteCloneDir = join(tempRoot, "remote-clone");
    await cloneRemoteRepo(remoteDir, remoteCloneDir);
    mkdirSync(join(remoteCloneDir, "reference", "history"), {
      recursive: true,
    });
    writeFileSync(
      join(remoteCloneDir, "reference", "history", "notes.md"),
      [
        "---",
        "description: Notes block",
        "---",
        "old value",
        "local line",
        "remote line",
      ].join("\n"),
      "utf8",
    );
    await runGit(remoteCloneDir, ["add", "reference/history/notes.md"]);
    await runGit(remoteCloneDir, ["commit", "-m", "Remote update notes"]);
    await runGit(remoteCloneDir, ["push", "origin", "main"]);

    const result = await runScopedMemory({
      command: "str_replace",
      reason: "Commit local replacement",
      file_path: "reference/history/notes.md",
      old_string: "old value",
      new_string: "new value",
    });

    expect(result.message).toContain("harness will sync after the turn");

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:reference/history/notes.md",
    ]);
    expect(content).toContain("new value");
    expect(content).not.toContain("remote line");

    const divergence = await runGit(memoryDir, [
      "rev-list",
      "--left-right",
      "--count",
      "@{u}...HEAD",
    ]);
    expect(divergence).toBe("0\t2");
  });

  test("falls back to context agent id when AGENT_ID env is missing", async () => {
    delete process.env.AGENT_ID;
    delete process.env.LETTA_AGENT_ID;

    const reason = "Create identity via context fallback";
    await runScopedMemory({
      command: "create",
      reason,
      file_path: "system/human/identity.md",
      description: "Identity block",
      file_text: "Name: Bob",
    });

    const authorEmail = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%ae",
    ]);
    expect(authorEmail).toBe(`${TEST_AGENT_ID}@letta.com`);
  });

  test("accepts relative file paths like system/contacts.md", async () => {
    const reason = "Create contacts via relative path";

    await runScopedMemory({
      command: "create",
      reason,
      file_path: "system/contacts.md",
      description: "Contacts memory",
      file_text: "Sarah: +1-555-0100",
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/contacts.md",
    ]);
    expect(content).toContain("description: Contacts memory");
    expect(content).toContain("Sarah: +1-555-0100");
  });

  test("accepts absolute file paths under MEMORY_DIR", async () => {
    const absolutePath = join(memoryDir, "system", "contacts.md");

    await runScopedMemory({
      command: "create",
      reason: "Create contacts via absolute path",
      file_path: absolutePath,
      description: "Contacts memory absolute",
      file_text: "Timber: good dog",
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/contacts.md",
    ]);
    expect(content).toContain("description: Contacts memory absolute");
    expect(content).toContain("Timber: good dog");
  });

  test("updates frontmatter description via update_description command", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Create coding prefs",
      file_path: "system/human/prefs/coding.md",
      description: "Old description",
      file_text: "keep body unchanged",
    });

    await runScopedMemory({
      command: "update_description",
      reason: "Update coding prefs description",
      file_path: "system/human/prefs/coding.md",
      description: "New description",
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/human/prefs/coding.md",
    ]);
    expect(content).toContain("description: New description");
    expect(content).toContain("keep body unchanged");
  });

  test("rename requires old_path and new_path", async () => {
    await expect(
      runScopedMemory({
        command: "rename",
        reason: "should fail",
        file_path: "system/contacts.md",
        description: "Should not update description via rename",
      } as Parameters<typeof memory>[0]),
    ).rejects.toThrow(/memory rename: 'old_path' must be a non-empty string/i);
  });

  test("delete supports recursive directory removal", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Create draft note one",
      file_path: "reference/history/draft-one.md",
      description: "Draft one",
      file_text: "one",
    });

    await runScopedMemory({
      command: "create",
      reason: "Create draft note two",
      file_path: "reference/history/draft-two.md",
      description: "Draft two",
      file_text: "two",
    });

    await runScopedMemory({
      command: "delete",
      reason: "Delete history directory",
      file_path: "reference/history",
    });

    const fileTree = await runGit(memoryDir, [
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
    ]);
    expect(fileTree).not.toContain("reference/history/draft-one.md");
    expect(fileTree).not.toContain("reference/history/draft-two.md");
  });

  test("rejects absolute paths outside MEMORY_DIR", async () => {
    await expect(
      runScopedMemory({
        command: "create",
        reason: "should fail",
        file_path: "/memories/contacts",
        description: "Contacts memory",
      }),
    ).rejects.toThrow(
      `The memory tool can only be used to modify files in {${memoryDir}} or provided as a relative path`,
    );
  });

  test("throws when a str_replace produces no effective changes", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Seed noop notes",
      file_path: "reference/history/notes.md",
      description: "Notes block",
      file_text: "unchanged value",
    });

    const headBefore = await runGit(memoryDir, ["rev-parse", "HEAD"]);

    // Replacing a string with itself leaves the file byte-identical.
    await expect(
      runScopedMemory({
        command: "str_replace",
        reason: "no-op replacement",
        file_path: "reference/history/notes.md",
        old_string: "unchanged value",
        new_string: "unchanged value",
      }),
    ).rejects.toThrow(/made no effective changes/i);

    // No phantom commit should have been created.
    const headAfter = await runGit(memoryDir, ["rev-parse", "HEAD"]);
    expect(headAfter).toBe(headBefore);
  });
});
