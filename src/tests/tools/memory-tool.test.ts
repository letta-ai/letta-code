import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const TEST_AGENT_ID = "agent-test-memory-tool";
const TEST_AGENT_NAME = "Bob";

mock.module("../../agent/context", () => ({
  getCurrentAgentId: () => TEST_AGENT_ID,
}));

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

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return String(stdout ?? "").trim();
}

describe("memory tool", () => {
  let tempRoot: string;
  let memoryDir: string;
  let remoteDir: string;

  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalAgentId = process.env.AGENT_ID;
  const originalAgentName = process.env.AGENT_NAME;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-memory-tool-"));
    memoryDir = join(tempRoot, "memory");
    remoteDir = join(tempRoot, "remote.git");

    // Bare remote
    await execFile("git", ["init", "--bare", remoteDir]);

    // Local memory repo
    await execFile("git", ["init", "-b", "main", memoryDir]);
    await runGit(memoryDir, ["config", "user.name", "setup"]);
    await runGit(memoryDir, ["config", "user.email", "setup@example.com"]);
    await runGit(memoryDir, ["remote", "add", "origin", remoteDir]);

    writeFileSync(join(memoryDir, ".gitkeep"), "", "utf8");
    await runGit(memoryDir, ["add", ".gitkeep"]);
    await runGit(memoryDir, ["commit", "-m", "initial"]);
    await runGit(memoryDir, ["push", "-u", "origin", "main"]);

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

    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("requires reason", async () => {
    await expect(
      memory({
        command: "create",
        path: "system/test.md",
        description: "test desc",
      } as Parameters<typeof memory>[0]),
    ).rejects.toThrow(/missing required parameter/i);
  });

  test("uses reason as commit message and agent identity as commit author", async () => {
    const reason = "Create coding preferences block";

    await memory({
      command: "create",
      reason,
      path: "system/human/prefs/coding.md",
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

  test("returns error when push fails but keeps local commit", async () => {
    await memory({
      command: "create",
      reason: "Seed notes",
      path: "reference/history/notes.md",
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
      memory({
        command: "str_replace",
        reason,
        path: "reference/history/notes.md",
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

  test("falls back to context agent id when AGENT_ID env is missing", async () => {
    delete process.env.AGENT_ID;
    delete process.env.LETTA_AGENT_ID;

    const reason = "Create identity via context fallback";
    await memory({
      command: "create",
      reason,
      path: "system/human/identity.md",
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

    await memory({
      command: "create",
      reason,
      path: "system/contacts.md",
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

    await memory({
      command: "create",
      reason: "Create contacts via absolute path",
      path: absolutePath,
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
    await memory({
      command: "create",
      reason: "Create coding prefs",
      path: "system/human/prefs/coding.md",
      description: "Old description",
      file_text: "keep body unchanged",
    });

    await memory({
      command: "update_description",
      reason: "Update coding prefs description",
      path: "system/human/prefs/coding.md",
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
      memory({
        command: "rename",
        reason: "should fail",
        path: "system/contacts.md",
        description: "Should not update description via rename",
      } as Parameters<typeof memory>[0]),
    ).rejects.toThrow(/memory rename: 'old_path' must be a non-empty string/i);
  });

  test("delete supports recursive directory removal", async () => {
    await memory({
      command: "create",
      reason: "Create draft note one",
      path: "reference/history/draft-one.md",
      description: "Draft one",
      file_text: "one",
    });

    await memory({
      command: "create",
      reason: "Create draft note two",
      path: "reference/history/draft-two.md",
      description: "Draft two",
      file_text: "two",
    });

    await memory({
      command: "delete",
      reason: "Delete history directory",
      path: "reference/history",
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
      memory({
        command: "create",
        reason: "should fail",
        path: "/memories/contacts",
        description: "Contacts memory",
      }),
    ).rejects.toThrow(
      `The memory tool can only be used to modify files in {${memoryDir}} or provided as a relative path`,
    );
  });
});
