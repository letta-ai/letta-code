import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFile as execFileCb } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const TEST_AGENT_ID = "agent-test-memory-apply-patch";
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

const { memory_apply_patch } = await import(
  "../../tools/impl/MemoryApplyPatch"
);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", args, { cwd });
  return String(stdout ?? "").trim();
}

describe("memory_apply_patch tool", () => {
  let tempRoot: string;
  let memoryDir: string;
  let remoteDir: string;

  const originalMemoryDir = process.env.MEMORY_DIR;
  const originalAgentId = process.env.AGENT_ID;
  const originalAgentName = process.env.AGENT_NAME;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "letta-memory-apply-patch-"));
    memoryDir = join(tempRoot, "memory");
    remoteDir = join(tempRoot, "remote.git");

    await execFile("git", ["init", "--bare", remoteDir]);
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

  test("requires reason and input", async () => {
    await expect(
      memory_apply_patch({
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
      "+limit: 2000",
      "+---",
      "+Sarah: cofounder",
      "*** End Patch",
    ].join("\n");

    await memory_apply_patch({
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

    await memory_apply_patch({
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

  test("rejects absolute paths outside MEMORY_DIR", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /tmp/outside.md",
      "+hello",
      "*** End Patch",
    ].join("\n");

    await expect(
      memory_apply_patch({
        reason: "should fail",
        input: patch,
      }),
    ).rejects.toThrow(/only be used to modify files/i);
  });

  test("rejects editing read_only memory files", async () => {
    await memory_apply_patch({
      reason: "seed read only",
      input: [
        "*** Begin Patch",
        "*** Add File: system/ro.md",
        "+---",
        "+description: Read only",
        "+limit: 2000",
        "+read_only: true",
        "+---",
        "+keep",
        "*** End Patch",
      ].join("\n"),
    });

    await expect(
      memory_apply_patch({
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
    await memory_apply_patch({
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
      memory_apply_patch({
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
});
