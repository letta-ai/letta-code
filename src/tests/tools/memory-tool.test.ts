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
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runWithRuntimeContext } from "../../runtime-context";

const execFile = promisify(execFileCb);

const TEST_AGENT_ID = "agent-test-memory-tool";
const TEST_AGENT_NAME = "Bob";

mock.module("../../agent/client", () => ({
  getClient: mock(() =>
    Promise.resolve({
      agents: {
        retrieve: mock(() => Promise.resolve({ name: TEST_AGENT_NAME })),
      },
    }),
  ),
  getServerUrl: () => "http://localhost:8283",
}));

const { memory } = await import("../../tools/impl/Memory");

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

async function listRescueRefs(cwd: string): Promise<string[]> {
  const output = await runGit(cwd, [
    "for-each-ref",
    "--format=%(refname)",
    "refs/letta-conflicts",
  ]);
  return output ? output.split("\n").filter(Boolean) : [];
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
    expect(remoteSubject).toBe(reason);
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

  test("returns error when push fails but keeps local commit", async () => {
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

    await expect(
      runScopedMemory({
        command: "str_replace",
        reason,
        file_path: "reference/history/notes.md",
        old_string: "old value",
        new_string: "new value",
      }),
    ).rejects.toThrow(/committed .* but push failed/i);

    const subject = await runGit(memoryDir, [
      "log",
      "-1",
      "--pretty=format:%s",
    ]);
    expect(subject).toBe(reason);
  });

  test("replays str_replace on top of newer remote memory", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Seed replay notes",
      file_path: "reference/history/notes.md",
      description: "Notes block",
      file_text: "old value\nlocal line",
    });

    const remoteCloneDir = join(tempRoot, "remote-clone");
    await cloneRemoteRepo(remoteDir, remoteCloneDir);
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
      reason: "Replay local replacement",
      file_path: "reference/history/notes.md",
      old_string: "old value",
      new_string: "new value",
    });

    expect(result.message).toContain(
      "reapplied on top of newer remote memory and pushed",
    );

    const content = await runGit(memoryDir, [
      "show",
      "HEAD:reference/history/notes.md",
    ]);
    expect(content).toContain("new value");
    expect(content).toContain("remote line");

    const divergence = await runGit(memoryDir, [
      "rev-list",
      "--left-right",
      "--count",
      "@{u}...HEAD",
    ]);
    expect(divergence).toBe("0\t0");
  });

  test("fails closed when replay cannot be applied safely", async () => {
    await runScopedMemory({
      command: "create",
      reason: "Seed conflicting notes",
      file_path: "reference/history/notes.md",
      description: "Notes block",
      file_text: "old value",
    });

    const remoteCloneDir = join(tempRoot, "remote-conflict-clone");
    await cloneRemoteRepo(remoteDir, remoteCloneDir);
    writeFileSync(
      join(remoteCloneDir, "reference", "history", "notes.md"),
      ["---", "description: Notes block", "---", "remote value"].join("\n"),
      "utf8",
    );
    await runGit(remoteCloneDir, ["add", "reference/history/notes.md"]);
    await runGit(remoteCloneDir, ["commit", "-m", "Remote conflicting update"]);
    await runGit(remoteCloneDir, ["push", "origin", "main"]);

    await expect(
      runScopedMemory({
        command: "str_replace",
        reason: "Attempt conflicting replacement",
        file_path: "reference/history/notes.md",
        old_string: "old value",
        new_string: "new value",
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
    expect(content).toContain("remote value");
    expect(content).not.toContain("new value");

    const rescueRefs = await listRescueRefs(memoryDir);
    expect(rescueRefs.length).toBeGreaterThan(0);

    const rescuedContent = await runGit(memoryDir, [
      "show",
      `${rescueRefs[0]}:reference/history/notes.md`,
    ]);
    expect(rescuedContent).toContain("new value");
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
});
