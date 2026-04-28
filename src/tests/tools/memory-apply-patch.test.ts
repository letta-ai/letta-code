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
import { runWithRuntimeContext } from "../../runtime-context";

const execFile = promisify(execFileCb);

const TEST_AGENT_ID = "agent-test-memory-apply-patch";
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

mock.module("../../agent/client", () => ({
  __testOverrideGetClient: (factory: (() => Promise<unknown>) | null) => {
    mockClientOverride = factory;
  },
  getClient: mock(getMockClient),
  LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV: "LETTA_MEMFS_GIT_PROXY_BASE_URL",
  getMemfsGitProxyRewriteConfig: getMockMemfsGitProxyRewriteConfig,
  getMemfsServerUrl: getMockMemfsServerUrl,
  getServerUrl: () => "http://localhost:8283",
}));

const { memory_apply_patch } = await import(
  "../../tools/impl/MemoryApplyPatch"
);

function runScopedMemoryApplyPatch(
  args: Parameters<typeof memory_apply_patch>[0],
) {
  return runWithRuntimeContext({ agentId: TEST_AGENT_ID }, () =>
    memory_apply_patch(args),
  );
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

async function listRescueRefs(cwd: string): Promise<string[]> {
  const output = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/letta-conflicts",
  ]);
  return output ? output.split("\n").filter(Boolean) : [];
}

describe("memory_apply_patch tool", () => {
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
    tempRoot = mkdtempSync(join(tmpdir(), "letta-memory-apply-patch-"));
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

  test("requires reason and input", async () => {
    await expect(
      runScopedMemoryApplyPatch({
        input: "*** Begin Patch\n*** End Patch",
      } as Parameters<typeof memory_apply_patch>[0]),
    ).rejects.toThrow(/missing required parameter/i);
  });

  test("adds and updates memory files with commit reason and agent author", async () => {
    const seedPatch = [
      "*** Begin Patch",
      "*** Add File: system/contacts.md",
      "+---",
      "+description: Contacts",
      "+---",
      "+Sarah: cofounder",
      "*** End Patch",
    ].join("\n");

    await runScopedMemoryApplyPatch({
      reason: "Create contacts memory via patch",
      input: seedPatch,
    });

    const updatePatch = [
      "*** Begin Patch",
      "*** Update File: system/contacts.md",
      "@@",
      "-Sarah: cofounder",
      "+Sarah: Letta cofounder",
      "*** End Patch",
    ].join("\n");

    await runScopedMemoryApplyPatch({
      reason: "Refine contacts memory via patch",
      input: updatePatch,
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/contacts.md",
    ]);
    expect(content).toContain("Sarah: Letta cofounder");

    const logOutput = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%s%n%an%n%ae",
    ]);
    const [subject, authorName, authorEmail] = logOutput.split("\n");
    expect(subject).toBe("Refine contacts memory via patch");
    expect(authorName).toBe(TEST_AGENT_NAME);
    expect(authorEmail).toBe(`${TEST_AGENT_ID}@letta.com`);
  });

  test("prefers scoped agent memory over stale MEMORY_DIR env", async () => {
    const scopedMemoryDir = memoryDir;
    const staleMemoryDir = join(tempRoot, "stale-memory");
    const scopedRemoteDir = join(tempRoot, "scoped-remote.git");

    await initTrackedMemoryRepo(staleMemoryDir, scopedRemoteDir);
    process.env.MEMORY_DIR = staleMemoryDir;

    await runScopedMemoryApplyPatch({
      reason: "Create scoped memory file via patch",
      input: [
        "*** Begin Patch",
        "*** Add File: system/scoped.md",
        "+---",
        "+description: Scoped file",
        "+---",
        "+scoped body",
        "*** End Patch",
      ].join("\n"),
    });

    const scopedContent = await runGit(scopedMemoryDir, [
      "show",
      "HEAD:system/scoped.md",
    ]);
    expect(scopedContent).toContain("scoped body");

    const staleStatus = await runGit(staleMemoryDir, ["status", "--short"]);
    expect(staleStatus).not.toContain("scoped.md");
  });

  test("rejects absolute paths outside MEMORY_DIR", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /tmp/outside.md",
      "+hello",
      "*** End Patch",
    ].join("\n");

    await expect(
      runScopedMemoryApplyPatch({
        reason: "should fail",
        input: patch,
      }),
    ).rejects.toThrow(/only be used to modify files/i);
  });

  test("accepts absolute paths under MEMORY_DIR", async () => {
    const absolutePath = join(memoryDir, "system", "absolute.md");

    await runScopedMemoryApplyPatch({
      reason: "add absolute memory path",
      input: [
        "*** Begin Patch",
        `*** Add File: ${absolutePath}`,
        "+---",
        "+description: Absolute path test",
        "+---",
        "+hello",
        "*** End Patch",
      ].join("\n"),
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/absolute.md",
    ]);
    expect(content).toContain("description: Absolute path test");
    expect(content).toContain("hello");
  });

  test("rejects editing read_only memory files", async () => {
    mkdirSync(join(memoryDir, "system"), { recursive: true });
    writeFileSync(
      join(memoryDir, "system", "ro.md"),
      ["---", "description: Read only", "read_only: true", "---", "keep"].join(
        "\n",
      ),
      "utf8",
    );
    await runGit(memoryDir, ["add", "system/ro.md"]);
    await runGit(memoryDir, ["commit", "-m", "seed read only"]);
    await runGit(memoryDir, ["push", "origin", "main"]);

    await expect(
      runScopedMemoryApplyPatch({
        reason: "attempt edit ro",
        input: [
          "*** Begin Patch",
          "*** Update File: system/ro.md",
          "@@",
          "-keep",
          "+change",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow(/read_only/i);
  });

  test("returns error when push fails but keeps local commit", async () => {
    await runScopedMemoryApplyPatch({
      reason: "seed notes",
      input: [
        "*** Begin Patch",
        "*** Add File: reference/history/notes.md",
        "+old",
        "*** End Patch",
      ].join("\n"),
    });

    await runGit(memoryDir, [
      "remote",
      "set-url",
      "origin",
      join(tempRoot, "missing-remote.git"),
    ]);

    const reason = "Update notes with failing push";
    await expect(
      runScopedMemoryApplyPatch({
        reason,
        input: [
          "*** Begin Patch",
          "*** Update File: reference/history/notes.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow(/committed .* but push failed/i);

    const subject = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%s",
    ]);
    expect(subject).toBe(reason);
  });

  test("replays patches on top of newer remote memory", async () => {
    await runScopedMemoryApplyPatch({
      reason: "seed replay patch notes",
      input: [
        "*** Begin Patch",
        "*** Add File: reference/history/notes.md",
        "+---",
        "+description: Notes block",
        "+---",
        "+old",
        "*** End Patch",
      ].join("\n"),
    });

    const remoteCloneDir = join(tempRoot, "remote-patch-clone");
    await cloneRemoteRepo(remoteDir, remoteCloneDir);
    writeFileSync(
      join(remoteCloneDir, "reference", "history", "notes.md"),
      ["---", "description: Notes block", "---", "old", "remote line"].join(
        "\n",
      ),
      "utf8",
    );
    await runGit(remoteCloneDir, ["add", "reference/history/notes.md"]);
    await runGit(remoteCloneDir, ["commit", "-m", "Remote patch update"]);
    await runGit(remoteCloneDir, ["push", "origin", "main"]);

    const result = await runScopedMemoryApplyPatch({
      reason: "Replay patch update",
      input: [
        "*** Begin Patch",
        "*** Update File: reference/history/notes.md",
        "@@",
        "-old",
        "+new",
        "*** End Patch",
      ].join("\n"),
    });

    expect(result.message).toContain(
      "reapplied on top of newer remote memory and pushed",
    );

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:reference/history/notes.md",
    ]);
    expect(content).toContain("new");
    expect(content).toContain("remote line");

    const divergence = await runGit(memoryDir, [
      "rev-list",
      "--left-right",
      "--count",
      "@{u}...HEAD",
    ]);
    expect(divergence).toBe("0\t0");
  });

  test("fails closed when replayed patch no longer matches remote", async () => {
    await runScopedMemoryApplyPatch({
      reason: "seed conflicting patch notes",
      input: [
        "*** Begin Patch",
        "*** Add File: reference/history/notes.md",
        "+---",
        "+description: Notes block",
        "+---",
        "+old",
        "*** End Patch",
      ].join("\n"),
    });

    const remoteCloneDir = join(tempRoot, "remote-patch-conflict-clone");
    await cloneRemoteRepo(remoteDir, remoteCloneDir);
    writeFileSync(
      join(remoteCloneDir, "reference", "history", "notes.md"),
      ["---", "description: Notes block", "---", "remote"].join("\n"),
      "utf8",
    );
    await runGit(remoteCloneDir, ["add", "reference/history/notes.md"]);
    await runGit(remoteCloneDir, ["commit", "-m", "Remote conflicting patch"]);
    await runGit(remoteCloneDir, ["push", "origin", "main"]);

    await expect(
      runScopedMemoryApplyPatch({
        reason: "Attempt conflicting patch replay",
        input: [
          "*** Begin Patch",
          "*** Update File: reference/history/notes.md",
          "@@",
          "-old",
          "+new",
          "*** End Patch",
        ].join("\n"),
      }),
    ).rejects.toThrow(/could not be replayed safely/i);

    const divergence = await runGit(memoryDir, [
      "rev-list",
      "--left-right",
      "--count",
      "@{u}...HEAD",
    ]);
    expect(divergence).toBe("0\t0");

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:reference/history/notes.md",
    ]);
    expect(content).toContain("remote");
    expect(content).not.toContain("new");

    const rescueRefs = await listRescueRefs(memoryDir);
    expect(rescueRefs.length).toBeGreaterThan(0);

    const rescuedContent = await runGit(memoryDir, [
      "show",
      `${rescueRefs[0]}:reference/history/notes.md`,
    ]);
    expect(rescuedContent).toContain("new");
  });

  test("updates files that omit frontmatter limit", async () => {
    await runScopedMemoryApplyPatch({
      reason: "seed no-limit memory",
      input: [
        "*** Begin Patch",
        "*** Add File: system/no-limit.md",
        "+---",
        "+description: No limit",
        "+---",
        "+before",
        "*** End Patch",
      ].join("\n"),
    });

    await runScopedMemoryApplyPatch({
      reason: "update no-limit memory",
      input: [
        "*** Begin Patch",
        "*** Update File: system/no-limit.md",
        "@@",
        "-before",
        "+after",
        "*** End Patch",
      ].join("\n"),
    });

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:system/no-limit.md",
    ]);
    expect(content).toContain("description: No limit");
    expect(content).not.toContain("limit:");
    expect(content).toContain("after");
  });
});
