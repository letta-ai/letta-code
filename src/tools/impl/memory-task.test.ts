import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearAllSubagents,
  getSnapshot,
  updateSubagent,
} from "@/agent/subagent-state";
import { __testSetBackend, type Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import {
  createTempGitRepo,
  type TempGitRepo,
} from "@/test-utils/temp-git-repo";
import { finishBackgroundMemoryTasks } from "./memory-task-lifecycle";
import { backgroundTasks } from "./process_manager";
import { spawnBackgroundSubagentTask } from "./task";

const roots: string[] = [];
const repos: TempGitRepo[] = [];
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
  for (const repo of repos.splice(0)) repo.cleanup();
});

test("memory delegates immediately, exports the originating conversation and launches fresh, and never notifies the primary", async () => {
  const repo = createTempGitRepo("memory-task-");
  repos.push(repo);
  const { dir: root, git } = repo;
  // Settings must not land inside the memory checkout, or sync sees them as dirty.
  const home = mkdtempSync(join(tmpdir(), "memory-task-home-"));
  roots.push(home);
  await settingsManager.reset();
  process.env.HOME = home;
  await settingsManager.initialize();
  writeFileSync(join(root, "note.md"), "memory\n");
  git("add", "note.md");
  git("commit", "-m", "initial");
  let startExport = () => {};
  const exportStarted = new Promise<void>((resolve) => {
    startExport = resolve;
  });
  let finishExport = () => {};
  const exportGate = new Promise<void>((resolve) => {
    finishExport = resolve;
  });
  const exports: string[] = [];
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
    listConversationMessages: async (conversationId: string) => {
      exports.push(conversationId);
      startExport();
      await exportGate;
      return { getPaginatedItems: () => [] };
    },
  } as unknown as Backend);
  const notifications: unknown[] = [];
  let completed = () => {};
  const completion = new Promise<void>((resolve) => {
    completed = resolve;
  });
  let spawned = false;
  let transcriptPath: string | undefined;
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
        expect(args[5]).toBeUndefined();
        expect(args[6]).toBeUndefined();
        expect(args[8]).toBeUndefined();
        expect(args[1]).toContain(`Memory repository: ${root}`);
        expect(args[1]).toContain("Remember Bun");
        expect(args[10]).toContain("memory-handoffs");
        transcriptPath = args[10];
        if (!transcriptPath) throw new Error("Missing handoff snapshot");
        expect(existsSync(transcriptPath)).toBe(true);
        expect(args[9]).toBe("agent-parent");
        expect(args[11]).toBe("conv-origin");
        expect(args[12]?.primaryRoot).toBe(root);
        updateSubagent(args[3], {
          agentId: "agent-worker",
          conversationId: "default",
        });
        const log = readFileSync(result.outputFile, "utf8");
        expect(log).toContain("agent_id=agent-worker conversation_id=default");
        expect(log).not.toContain("[Task completed]");
        return {
          agentId: "agent-worker",
          conversationId: "default",
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
  await exportStarted;
  let drained = false;
  const drain = finishBackgroundMemoryTasks("agent-parent", "conv-origin").then(
    () => {
      drained = true;
    },
  );
  await Bun.sleep(10);
  expect(drained).toBe(false);
  finishExport();
  await drain;
  await completion;
  expect(exports).toEqual(["conv-origin"]);
  expect(spawned, backgroundTasks.get(result.taskId)?.error).toBe(true);
  // Assertions inside the spawn stub surface here: a throw there fails the task.
  const task = backgroundTasks.get(result.taskId);
  expect(task?.error).toBeUndefined();
  expect(task?.status).toBe("completed");
  const log = readFileSync(result.outputFile, "utf8");
  expect(log.split("saved").length - 1).toBe(1);
  expect(log).toContain("[Task completed]");
  expect(notifications).toEqual([]);
  if (!transcriptPath) throw new Error("Missing handoff snapshot");
  expect(existsSync(transcriptPath)).toBe(false);
});

test("a failed transcript export terminates the silent task with an inspectable error", async () => {
  const repo = createTempGitRepo("memory-task-failed-");
  repos.push(repo);
  const root = repo.dir;
  const home = mkdtempSync(join(tmpdir(), "memory-task-failed-home-"));
  roots.push(home);
  await settingsManager.reset();
  process.env.HOME = home;
  await settingsManager.initialize();
  __testSetBackend({
    capabilities: { localMemfs: true, remoteMemfs: false },
    listConversationMessages: async () => {
      throw new Error("Transcript unavailable");
    },
  } as unknown as Backend);
  let notified = false;
  const task = spawnBackgroundSubagentTask({
    subagentType: "memory",
    description: "remember",
    prompt: "Remember Bun",
    parentScope: { agentId: "agent-parent", conversationId: "conv-origin" },
    memoryScope: { primaryRoot: root, writableRoots: [root] },
    deps: {
      spawnSubagentImpl: async () => {
        throw new Error("Must not launch without handoff");
      },
      addToMessageQueueImpl: () => {
        notified = true;
      },
      runSubagentStopHooksImpl: async () => ({
        blocked: false,
        errored: false,
        feedback: [],
        results: [],
      }),
    },
  });
  await finishBackgroundMemoryTasks("agent-parent", "conv-origin");
  expect(backgroundTasks.get(task.taskId)?.status).toBe("failed");
  expect(readFileSync(task.outputFile, "utf8")).toContain(
    "[error] Transcript unavailable\n\n[Task failed]",
  );
  expect(notified).toBe(false);
});
