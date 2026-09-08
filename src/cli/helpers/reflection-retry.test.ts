import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReflectionMemoryWorktreeFinalizeResult } from "@/agent/memory-worktree";
import { createContextTracker } from "@/cli/helpers/context-tracker";
import { maybeLaunchPostTurnReflection } from "@/cli/helpers/post-turn-reflection";
import {
  launchReflectionSubagent,
  type ReflectionLaunchOptions,
  shouldRunQueuedReflectionLaunch,
} from "@/cli/helpers/reflection-launcher";
import {
  isReflectionRetryDeferred,
  recordReflectionIntegrationRetry,
} from "@/cli/helpers/reflection-retry";
import {
  appendTranscriptDeltaJsonl,
  getReflectionTranscriptState,
} from "@/cli/helpers/reflection-transcript";
import { createSharedReminderState } from "@/reminders/state";
import * as task from "@/tools/impl/task";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});

function git(cwd: string, args: string[]) {
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
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "reflection-retry-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  for (const [key, value] of Object.entries({
    LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
    LETTA_LOCAL_BACKEND_DIR: root,
    LETTA_TRANSCRIPT_ROOT: join(root, "transcripts"),
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    cleanup.push(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const agentId = `agent-local-${crypto.randomUUID()}`;
  const conversationId = "conv-retry";
  const memory = join(root, "memfs", agentId, "memory");
  mkdirSync(memory, { recursive: true });
  git(memory, ["init", "-b", "main"]);
  writeFileSync(join(memory, "MEMORY.md"), "Before\n");
  git(memory, ["add", "MEMORY.md"]);
  git(memory, ["commit", "-m", "Initial"]);
  // A real fetch failure without network access or credentials.
  git(memory, ["remote", "add", "origin", join(root, "missing-origin")]);
  await appendTranscriptDeltaJsonl(agentId, conversationId, [
    { kind: "user", id: "u1", text: "Remember this", messageId: "msg-u1" },
    {
      kind: "assistant",
      id: "a1",
      text: "Response",
      phase: "finished",
      messageId: "msg-a1",
    },
  ]);
  const spawned: task.SpawnBackgroundSubagentTaskArgs[] = [];
  const spawn = spyOn(task, "spawnBackgroundSubagentTask").mockImplementation(
    (args) => {
      spawned.push(args);
      return {
        taskId: "test-task",
        subagentId: `test-${spawned.length}`,
        outputFile: "unused",
      };
    },
  );
  const wait = spyOn(
    task,
    "waitForBackgroundSubagentAgentId",
  ).mockResolvedValue(null);
  cleanup.push(
    () => spawn.mockRestore(),
    () => wait.mockRestore(),
  );
  const notifications: string[] = [];
  const options: ReflectionLaunchOptions = {
    agentId,
    conversationId,
    memfsEnabled: true,
    triggerSource: "step-count",
    reflectionSettings: { trigger: "step-count", stepCount: 1 },
    description: "Test reflection",
    recompileByConversation: new Map(),
    recompileQueuedByConversation: new Set(),
    onCompletionMessage: (message) => {
      notifications.push(message);
    },
  };
  const launch = (triggerSource = options.triggerSource) =>
    launchReflectionSubagent(
      { ...options, triggerSource },
      { isCutover: async () => false },
    );
  const postTurn = () =>
    maybeLaunchPostTurnReflection({
      ...options,
      reflectionSettings: { trigger: "step-count", stepCount: 1 },
      reminderState: createSharedReminderState(),
      contextTracker: createContextTracker(),
      launch: async (trigger) => (await launch(trigger)).launched,
    });
  const complete = async (changes = true) => {
    const args = spawned.at(-1);
    if (!args?.onComplete) throw new Error("Reflection was not launched");
    if (changes) {
      const dir = args.memoryScope?.primaryRoot;
      if (!dir) throw new Error("Reflection has no memory worktree");
      writeFileSync(join(dir, "MEMORY.md"), "After\n");
      git(dir, ["add", "MEMORY.md"]);
      git(dir, ["commit", "-m", "Reflection"]);
    }
    await args.onComplete({
      success: true,
      agentId: "agent-local-reflector",
      report: "Done",
    });
  };
  return {
    agentId,
    conversationId,
    options,
    launch,
    postTurn,
    complete,
    spawned,
    notifications,
  };
}

test("failed integration defers repeated turns and queued launches without consuming the transcript", async () => {
  const f = await fixture();
  expect(await f.postTurn()).toBe(true);
  await f.complete();
  expect(f.notifications).toHaveLength(1);
  expect(f.notifications[0]).toContain(
    "parent memory repo could not be refreshed",
  );
  expect(await shouldRunQueuedReflectionLaunch(f.options)).toBe(false);
  expect(
    await shouldRunQueuedReflectionLaunch({
      ...f.options,
      triggerSource: "compaction-event",
    }),
  ).toBe(false);
  for (let i = 0; i < 3; i++) expect(await f.postTurn()).toBe(false);
  expect(f.spawned).toHaveLength(1);
  const state = await getReflectionTranscriptState(f.agentId, f.conversationId);
  expect(state.reflected_through_message_id).toBeUndefined();
  expect(state.steps_since_last_successful_reflection).toBe(1);
});

test("automatic retries back off, suppress duplicate warnings, and manual success clears the delay", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  cleanup.push(() => clock.mockRestore());
  const f = await fixture();
  expect((await f.launch()).launched).toBe(true);
  await f.complete();
  now += 60_000;
  expect((await f.launch()).launched).toBe(true);
  await f.complete();
  expect(f.notifications).toHaveLength(1);
  now += 60_000;
  expect((await f.launch()).launched).toBe(false); // next delay doubled
  expect((await f.launch("manual")).launched).toBe(true);
  await f.complete();
  expect(f.notifications).toHaveLength(2); // explicit requests always get a result
  expect((await f.launch("manual")).launched).toBe(true);
  await f.complete(false); // successful no-op consumes the transcript
  expect(f.notifications).toHaveLength(3);
  const state = await getReflectionTranscriptState(f.agentId, f.conversationId);
  expect(state.reflected_through_message_id).toBe("msg-a1");
  expect(state.steps_since_last_successful_reflection).toBe(0);
  // No cooldown remains: the launch reaches the existing no-payload check.
  expect(await f.launch()).toEqual({ launched: false, reason: "no_payload" });
});

test("retry delay caps at 30 minutes, reports a different failure, and resets after a merge", () => {
  const agentId = `retry-policy-${crypto.randomUUID()}`;
  const integration: ReflectionMemoryWorktreeFinalizeResult = {
    status: "failed",
    failurePhase: "integration",
    parentMemoryDir: "memory",
    reflectionWorktreeDir: "worktree",
    reflectionBranch: "reflection",
    commitCount: 1,
    summary: "Parent refresh failed",
  };
  let now = 1_000;
  for (let attempt = 0; attempt < 10; attempt++) {
    expect(
      recordReflectionIntegrationRetry(
        agentId,
        integration,
        false,
        "step-count",
        now,
      ),
    ).toBe(attempt === 0);
    const delay = Math.min(60_000 * 2 ** attempt, 30 * 60_000);
    expect(
      isReflectionRetryDeferred(agentId, "step-count", now + delay - 1),
    ).toBe(true);
    expect(isReflectionRetryDeferred(agentId, "step-count", now + delay)).toBe(
      false,
    );
    expect(isReflectionRetryDeferred(agentId, "manual", now)).toBe(false);
    expect(isReflectionRetryDeferred("another-agent", "step-count", now)).toBe(
      false,
    );
    now += delay;
  }
  expect(
    recordReflectionIntegrationRetry(
      agentId,
      { ...integration, status: "merge_conflict" },
      false,
      "step-count",
      now,
    ),
  ).toBe(true);
  recordReflectionIntegrationRetry(
    agentId,
    { ...integration, status: "merged" },
    true,
    "manual",
    now,
  );
  expect(isReflectionRetryDeferred(agentId, "step-count", now)).toBe(false);
  expect(
    recordReflectionIntegrationRetry(
      agentId,
      integration,
      false,
      "step-count",
      now,
    ),
  ).toBe(true);
  expect(isReflectionRetryDeferred(agentId, "step-count", now + 60_000)).toBe(
    false,
  );
});

test("subagent execution errors retain their existing retry policy", () => {
  const agentId = `retry-execution-${crypto.randomUUID()}`;
  recordReflectionIntegrationRetry(
    agentId,
    {
      status: "failed",
      parentMemoryDir: "memory",
      reflectionWorktreeDir: "worktree",
      reflectionBranch: "reflection",
      commitCount: 0,
      summary: "Subagent failed",
    },
    false,
    "step-count",
  );
  expect(isReflectionRetryDeferred(agentId, "step-count")).toBe(false);
});
