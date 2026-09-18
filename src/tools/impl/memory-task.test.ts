import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearAllSubagents, getSnapshot } from "@/agent/subagent-state";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { finishBackgroundMemoryTasks } from "./memory-task-lifecycle";
import { backgroundTasks } from "./process_manager";
import { spawnBackgroundSubagentTask } from "./task";

const roots: string[] = [];
const originalHome = process.env.HOME;
afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  __testSetBackend(null);
  clearAllSubagents();
  for (const task of backgroundTasks.values())
    rmSync(task.outputFile, { force: true });
  backgroundTasks.clear();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("memory delegates immediately, forks the originating conversation, and never notifies the primary", async () => {
  const root = mkdtempSync(join(tmpdir(), "memory-task-"));
  roots.push(root);
  await settingsManager.reset();
  process.env.HOME = root;
  await settingsManager.initialize();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(root, "note.md"), "memory\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  let startFork = () => {};
  const forkStarted = new Promise<void>((resolve) => {
    startFork = resolve;
  });
  let finishFork = () => {};
  const forkGate = new Promise<void>((resolve) => {
    finishFork = resolve;
  });
  const forks: string[] = [];
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
    forkConversation: async (
      conversationId: string,
      options: { hidden: boolean },
    ) => {
      forks.push(conversationId);
      expect(options.hidden).toBe(true);
      startFork();
      await forkGate;
      return { id: "conv-memory-fork" };
    },
  } as unknown as Backend);
  const notifications: unknown[] = [];
  let completed = () => {};
  const completion = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let spawned = false;
  const result = spawnBackgroundSubagentTask({
    subagentType: "memory",
    description: "remember preference",
    prompt: "Remember Bun",
    parentScope: { agentId: "agent-parent", conversationId: "conv-origin" },
    memoryScope: { primaryRoot: root, writableRoots: [root] },
    // Even explicit notification requests must not wake the primary for memory work.
    emitCompletionNotification: true,
    onComplete: () => {
      completed();
    },
    deps: {
      spawnSubagentImpl: async (...args) => {
        spawned = true;
        expect(args[0]).toBe("memory");
        expect(args[5]).toBe("agent-parent");
        expect(args[6]).toBe("conv-memory-fork");
        expect(args[8]).toBe(true);
        expect(args[9]).toBe("agent-parent");
        expect(args[11]).toBe("conv-origin");
        expect(args[12]?.primaryRoot).toBe(root);
        return {
          agentId: "agent-parent",
          conversationId: "conv-memory-fork",
          success: true,
          report: "saved",
        };
      },
      copyGitHubPullRequestTagsImpl: async () => {},
      addToMessageQueueImpl: (message) => {
        notifications.push(message);
      },
      runSubagentStopHooksImpl: async () => ({
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      }),
    },
  });
  expect(result.taskId).toBeDefined();
  expect(spawned).toBe(false);
  expect(
    getSnapshot().agents.find((agent) => agent.id === result.subagentId)
      ?.silent,
  ).toBe(true);
  await forkStarted;
  let drained = false;
  const drain = finishBackgroundMemoryTasks("agent-parent", "conv-origin").then(
    () => {
      drained = true;
    },
  );
  await Bun.sleep(10);
  expect(drained).toBe(false);
  finishFork();
  await drain;
  await completion;
  expect(forks).toEqual(["conv-origin"]);
  expect(spawned, backgroundTasks.get(result.taskId)?.error).toBe(true);
  expect(notifications).toEqual([]);
});
