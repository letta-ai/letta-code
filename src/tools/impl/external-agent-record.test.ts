import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __setExternalCodingAgentTaskDirectoryForTests,
  bindExternalCodingAgentSession,
  createExternalCodingAgentTaskStore,
  type ExternalCodingAgentTaskRecord,
  isExternalCodingAgentTaskHostAlive,
  recordExternalCodingAgentTask,
  reportInterruptedExternalCodingAgentTasks,
} from "./external-agent-record";
import type { BackgroundTask } from "./process_manager";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_AGENT_ID = `claude_${SESSION_ID}`;
// No real process should ever hold a PID this large.
const DEAD_PID = 2 ** 22 + 12_345;

type QueuedNotification = {
  kind: string;
  text: string;
  agentId?: string;
  conversationId?: string;
  actingUserId?: string;
};

function backgroundTask(overrides: Partial<BackgroundTask> = {}) {
  return {
    description: "Fix the flaky test",
    subagentType: "claude-code",
    subagentId: "subagent-1",
    status: "running",
    startTime: new Date("2026-10-02T17:45:00.000Z"),
    outputFile: "/tmp/task.log",
    runtimeScope: { agentId: "agent-parent", conversationId: "conv-parent" },
    actingUserId: "user-1",
    ...overrides,
  } as BackgroundTask;
}

function staleRecord(
  overrides: Partial<ExternalCodingAgentTaskRecord> = {},
): ExternalCodingAgentTaskRecord {
  return {
    taskId: "task_1",
    subagentId: "subagent-stale",
    type: "claude-code",
    agentId: CLAUDE_AGENT_ID,
    nativeSessionId: SESSION_ID,
    cwd: "/root/workspace/repo",
    description: "Fix the flaky test",
    parentAgentId: "agent-parent",
    parentConversationId: "conv-parent",
    actingUserId: "user-1",
    startedAt: "2026-10-02T17:45:00.000Z",
    hostPid: DEAD_PID,
    ...overrides,
  };
}

describe("external coding agent task records", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "external-agent-tasks-"));
    __setExternalCodingAgentTaskDirectoryForTests(directory);
  });

  afterEach(() => {
    __setExternalCodingAgentTaskDirectoryForTests(undefined);
    rmSync(directory, { recursive: true, force: true });
  });

  test("persists a running task with its parent, cwd, and resume ID, then clears it", () => {
    const finish = recordExternalCodingAgentTask("task_1", backgroundTask());
    const store = createExternalCodingAgentTaskStore(directory);

    expect(store.list()).toEqual([
      expect.objectContaining({
        taskId: "task_1",
        subagentId: "subagent-1",
        type: "claude-code",
        description: "Fix the flaky test",
        parentAgentId: "agent-parent",
        parentConversationId: "conv-parent",
        hostPid: process.pid,
      }),
    ]);
    expect(store.list()[0]?.agentId).toBeUndefined();

    bindExternalCodingAgentSession("subagent-1", CLAUDE_AGENT_ID);
    expect(store.list()[0]).toMatchObject({
      agentId: CLAUDE_AGENT_ID,
      nativeSessionId: SESSION_ID,
    });

    finish();
    expect(store.list()).toEqual([]);
  });

  test("records a follow-up turn with the session it resumes", () => {
    recordExternalCodingAgentTask(
      "task_2",
      backgroundTask({ subagentType: "codex", subagentId: "subagent-2" }),
      `codex_${SESSION_ID}`,
    );

    expect(createExternalCodingAgentTaskStore(directory).list()).toEqual([
      expect.objectContaining({
        type: "codex",
        agentId: `codex_${SESSION_ID}`,
        nativeSessionId: SESSION_ID,
      }),
    ]);
  });

  test("does not record Letta subagents or tasks with no parent to notify", () => {
    recordExternalCodingAgentTask(
      "task_3",
      backgroundTask({ subagentType: "general-purpose" }),
    );
    recordExternalCodingAgentTask(
      "task_4",
      backgroundTask({ runtimeScope: undefined }),
    );

    expect(readdirSync(directory)).toEqual([]);
  });

  test("notifies the parent conversation once about a task whose runtime died", () => {
    const store = createExternalCodingAgentTaskStore(directory);
    store.write(staleRecord());
    const queued: QueuedNotification[] = [];

    const reported = reportInterruptedExternalCodingAgentTasks({
      enqueue: (message) => queued.push(message as QueuedNotification),
    });

    expect(reported).toBe(1);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      kind: "task_notification",
      agentId: "agent-parent",
      conversationId: "conv-parent",
      actingUserId: "user-1",
    });
    expect(queued[0]?.text).toContain("<task-id>task_1</task-id>");
    expect(queued[0]?.text).toContain("<status>failed</status>");
    expect(queued[0]?.text).toContain(
      `Resume with SendAgentMessage to \`${CLAUDE_AGENT_ID}\``,
    );
    expect(queued[0]?.text).toContain("/root/workspace/repo");
    expect(store.list()).toEqual([]);

    expect(
      reportInterruptedExternalCodingAgentTasks({
        enqueue: (message) => queued.push(message as QueuedNotification),
      }),
    ).toBe(0);
    expect(queued).toHaveLength(1);
  });

  test("says so when the task died before its session ID was known", () => {
    createExternalCodingAgentTaskStore(directory).write(
      staleRecord({ agentId: undefined, nativeSessionId: undefined }),
    );
    const queued: QueuedNotification[] = [];

    reportInterruptedExternalCodingAgentTasks({
      enqueue: (message) => queued.push(message as QueuedNotification),
    });

    expect(queued[0]?.text).toContain("No resumable session was recorded");
    expect(queued[0]?.text).not.toContain(" agent_id=");
  });

  test("leaves records alone while their runtime is still alive", () => {
    const store = createExternalCodingAgentTaskStore(directory);
    store.write(staleRecord({ hostPid: 4242 }));
    const queued: QueuedNotification[] = [];

    const reported = reportInterruptedExternalCodingAgentTasks({
      isHostAlive: () => true,
      enqueue: (message) => queued.push(message as QueuedNotification),
    });

    expect(reported).toBe(0);
    expect(queued).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  test("skips tasks this process owns but reports a recycled PID", () => {
    recordExternalCodingAgentTask("task_live", backgroundTask());
    const store = createExternalCodingAgentTaskStore(directory);
    store.write(
      staleRecord({ subagentId: "subagent-recycled", hostPid: process.pid }),
    );
    const queued: QueuedNotification[] = [];

    const reported = reportInterruptedExternalCodingAgentTasks({
      isHostAlive: () => true,
      enqueue: (message) => queued.push(message as QueuedNotification),
    });

    expect(reported).toBe(1);
    expect(store.list().map((record) => record.subagentId)).toEqual([
      "subagent-1",
    ]);
  });

  test("two concurrent sweeps wake the parent exactly once", () => {
    createExternalCodingAgentTaskStore(directory).write(staleRecord());
    const queued: QueuedNotification[] = [];
    const first = createExternalCodingAgentTaskStore(directory);
    const second = createExternalCodingAgentTaskStore(directory);
    const listed = first.list();

    // Both sweeps observed the record before either claimed it.
    const racingStore = { ...second, list: () => listed };
    const enqueue = (message: unknown) =>
      queued.push(message as QueuedNotification);
    reportInterruptedExternalCodingAgentTasks({ store: first, enqueue });
    reportInterruptedExternalCodingAgentTasks({ store: racingStore, enqueue });

    expect(queued).toHaveLength(1);
  });

  test("ignores corrupt and misplaced record files", () => {
    const store = createExternalCodingAgentTaskStore(directory);
    store.write(staleRecord());
    writeFileSync(join(directory, "garbage.json"), "{not json");
    writeFileSync(
      join(directory, `${DEAD_PID}-other.json`),
      JSON.stringify(staleRecord({ subagentId: "subagent-elsewhere" })),
    );

    expect(store.list().map((record) => record.subagentId)).toEqual([
      "subagent-stale",
    ]);
  });
});

describe("isExternalCodingAgentTaskHostAlive", () => {
  test("treats a vanished PID as dead", () => {
    expect(isExternalCodingAgentTaskHostAlive({ hostPid: DEAD_PID })).toBe(
      false,
    );
  });

  test("treats this process as alive", () => {
    expect(isExternalCodingAgentTaskHostAlive({ hostPid: process.pid })).toBe(
      true,
    );
  });

  test.skipIf(!existsSync("/proc/self/stat"))(
    "treats a live PID with a different start time as a restarted runtime",
    () => {
      expect(
        isExternalCodingAgentTaskHostAlive({
          hostPid: process.pid,
          hostStartTicks: "1",
        }),
      ).toBe(false);
    },
  );

  test.skipIf(!existsSync("/proc/sys/kernel/random/boot_id"))(
    "treats a record from a previous boot as dead",
    () => {
      expect(
        isExternalCodingAgentTaskHostAlive({
          hostPid: process.pid,
          hostBootId: "00000000-0000-0000-0000-000000000000",
        }),
      ).toBe(false);
    },
  );
});
