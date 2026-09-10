import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryPostTurnSyncResult } from "@/agent/memory-git";
import type { SpawnBackgroundSubagentTaskArgs } from "@/tools/impl/task";
import { type DoctorCommandOptions, launchDoctor } from "./doctor-command";

let tempDir: string;
let memoryDir: string;
let task: SpawnBackgroundSubagentTaskArgs;
const recompile = mock(async () => "compiled memory");
const spawn = mock((args: SpawnBackgroundSubagentTaskArgs) => {
  task = args;
  return {
    taskId: "doctor-task",
    outputFile: "/tmp/doctor-report",
    subagentId: "investigator",
  };
});
const syncMemory = mock(
  async (): Promise<MemoryPostTurnSyncResult> => ({
    status: "skipped",
    localOnly: true,
    memoryDir,
    summary: "Local memory",
  }),
);

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  }).trim();
}

function options(): DoctorCommandOptions {
  return {
    agentId: "agent-target",
    conversationId: "conv-target",
    memoryDir,
    symptom: "Confused two Slack users",
    actingUserId: "user-requester",
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    recompileAgentSystemPromptImpl: recompile,
  };
}

function repair(commit = true) {
  const dir = task.memoryScope?.primaryRoot;
  if (!dir) throw new Error("Expected an isolated memory worktree");
  writeFileSync(join(dir, "facts.md"), "Correct identity mapping\n");
  if (commit) {
    git(dir, "add", "facts.md");
    git(dir, "commit", "-m", "fix(doctor): correct identity mapping");
  }
  return dir;
}

async function complete(success = true, error?: string) {
  await task.onComplete?.({ success, error });
  return typeof task.completionSummary === "function"
    ? await task.completionSummary({ success, error })
    : task.completionSummary;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "doctor-command-"));
  memoryDir = join(tempDir, "memory");
  git(tempDir, "init", "-b", "main", memoryDir);
  writeFileSync(join(memoryDir, "MEMORY.md"), "# Memory\n");
  git(memoryDir, "add", "MEMORY.md");
  git(memoryDir, "commit", "-m", "initial memory");
  spawn.mockClear();
  recompile.mockReset();
  recompile.mockImplementation(async () => "compiled memory");
  syncMemory.mockClear();
});

afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

test("launches a fresh scoped investigator and merges, syncs, then recompiles a repair", async () => {
  const events: string[] = [];
  const opts = options();
  opts.recompileAgentSystemPromptImpl = async (conversationId, agentId) => {
    expect({ conversationId, agentId }).toEqual({
      conversationId: "conv-target",
      agentId: "agent-target",
    });
    events.push("recompile");
    return "compiled memory";
  };
  const result = await launchDoctor(opts, {
    spawn,
    isLocal: () => false,
    syncMemory: async (agentId, syncOptions) => {
      expect(agentId).toBe("agent-target");
      expect(syncOptions?.memoryDir).toBe(memoryDir);
      expect(readFileSync(join(memoryDir, "facts.md"), "utf8")).toContain(
        "Correct identity",
      );
      events.push("sync");
      return {
        status: "pushed",
        localOnly: false,
        memoryDir,
        summary: "Pushed",
      };
    },
  });
  expect(result).toContain("doctor-task");
  expect(task.subagentType).toBe("doctor");
  expect(task.parentScope).toEqual({
    agentId: "agent-target",
    conversationId: "conv-target",
  });
  expect(task.actingUserId).toBe("user-requester");
  expect(task.existingAgentId).toBeUndefined();
  expect(task.forkedContext).toBeUndefined();
  expect(task.prompt).toContain("Memory format: memfs-v2");
  expect(task.prompt).toContain("Confused two Slack users");
  expect(task.prompt).toContain("agent-target/conv-target");
  expect(task.memoryScope?.writableRoots).not.toContain(memoryDir);
  const worktreeDir = repair();
  // A switch in the caller must not redirect the completion.
  opts.conversationId = "conv-switched";
  expect(await complete()).toBe("Doctor applied memory changes.");
  expect(events).toEqual(["sync", "recompile"]);
  expect(existsSync(worktreeDir)).toBe(false);
});

test("local repairs use the existing local sync result and recompile", async () => {
  await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
  expect(task.prompt).toContain("Memory format: memfs-v1");
  repair();
  expect(await complete()).toBe("Doctor applied memory changes.");
  expect(recompile).toHaveBeenCalledWith("conv-target", "agent-target");
});

test("diagnosis without memory launches without creating a memory scope", async () => {
  await launchDoctor(
    { ...options(), memoryDir: undefined },
    { spawn, syncMemory, isLocal: () => true },
  );
  expect(task.memoryScope).toBeUndefined();
  expect(task.prompt).toContain("Diagnosis only");
  expect(await complete()).toContain("no memory changes applied");
  expect(syncMemory).not.toHaveBeenCalled();
  expect(recompile).not.toHaveBeenCalled();
});

test("no changes and failed tasks clean up without claiming a repair", async () => {
  await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
  const noChangesDir = task.memoryScope?.primaryRoot ?? "";
  expect(await complete()).toContain("no memory changes applied");
  expect(existsSync(noChangesDir)).toBe(false);
  await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
  const failedDir = repair();
  expect(await complete(false, "cancelled")).toBe("Doctor failed: cancelled");
  expect(existsSync(failedDir)).toBe(false);
  expect(existsSync(join(memoryDir, "facts.md"))).toBe(false);
  expect(recompile).not.toHaveBeenCalled();
});

test.each(["before launch", "during investigation"])(
  "preserves dirty parent memory %s",
  async (when) => {
    if (when === "before launch")
      writeFileSync(join(memoryDir, "in-progress.md"), "user edit");
    await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
    if (when === "before launch")
      expect(task.prompt).toContain("Diagnosis only");
    else writeFileSync(join(memoryDir, "in-progress.md"), "user edit");
    const worktreeDir = repair();
    const summary = await complete();
    expect(summary).not.toContain("Doctor applied");
    expect(readFileSync(join(memoryDir, "in-progress.md"), "utf8")).toBe(
      "user edit",
    );
    expect(existsSync(join(memoryDir, "facts.md"))).toBe(false);
    expect(existsSync(worktreeDir)).toBe(false);
    expect(recompile).not.toHaveBeenCalled();
  },
);

test("uncommitted investigator edits are not integrated", async () => {
  await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
  repair(false);
  expect(await complete()).toContain("dirty_uncommitted");
  expect(existsSync(join(memoryDir, "facts.md"))).toBe(false);
  expect(recompile).not.toHaveBeenCalled();
});

test("sync failure preserves the local commit and skips stale remote recompilation", async () => {
  await launchDoctor(options(), {
    spawn,
    isLocal: () => false,
    syncMemory: async () => ({
      status: "push_failed",
      localOnly: false,
      memoryDir,
      summary: "offline",
    }),
  });
  repair();
  expect(await complete()).toContain(
    "committed memory changes locally, but could not sync",
  );
  expect(existsSync(join(memoryDir, "facts.md"))).toBe(true);
  expect(recompile).not.toHaveBeenCalled();
});

test("recompile failures are visible after successful integration", async () => {
  recompile.mockRejectedValueOnce(new Error("recompile unavailable"));
  await launchDoctor(options(), { spawn, syncMemory, isLocal: () => true });
  repair();
  expect(await complete()).toContain(
    "System prompt recompilation failed: recompile unavailable",
  );
});

test("launch errors remove the prepared worktree", async () => {
  await expect(
    launchDoctor(options(), {
      isLocal: () => true,
      spawn: () => {
        throw new Error("cannot spawn");
      },
    }),
  ).rejects.toThrow("cannot spawn");
  expect(
    git(memoryDir, "worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(1);
});
