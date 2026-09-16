import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  __testFailNextRefreshSchedulerLease,
  __testThrowNextRefreshSchedulerLease,
  type AddTaskInput,
  addTask,
  type CronTask,
  claimSchedulerLease,
  deleteTask,
  getTask,
  pauseTask,
  readCronFile,
  updateTask,
} from "@/cron/cron-file";
import { cronMatchesTime } from "@/cron/parse-interval";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  CRON_SCHEDULER_SCOPE_ENV,
  formatCronPrompt,
  getIntendedCronOccurrence,
  handleMissedOneShot,
  handleTaskPreflight,
  isSchedulerRunning,
  resolveCronSchedulerScope,
  startScheduler,
  stopScheduler,
  taskMatchesCronSchedulerScope,
  wrapCronPrompt,
} from "@/cron/scheduler";
import type { ListenerTransport } from "@/websocket/listener/transport";
import type { StartListenerOptions } from "@/websocket/listener/types";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__scheduler_test_tmp__");
const origHome = process.env.LETTA_HOME;
const origCronScope = process.env[CRON_SCHEDULER_SCOPE_ENV];

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  delete process.env[CRON_SCHEDULER_SCOPE_ENV];
});

afterEach(() => {
  __testFailNextRefreshSchedulerLease(false);
  __testThrowNextRefreshSchedulerLease(false);
  stopScheduler();
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.LETTA_HOME = origHome;
  else delete process.env.LETTA_HOME;
  if (origCronScope) process.env[CRON_SCHEDULER_SCOPE_ENV] = origCronScope;
  else delete process.env[CRON_SCHEDULER_SCOPE_ENV];
});

test("routes scheduler lease failures through the listener logger", () => {
  writeFileSync(
    path.join(TEST_DIR, "crons.json"),
    JSON.stringify({
      version: 1,
      scheduler_owner: {
        pid: process.ppid,
        token: "held-by-another-process",
        started_at: new Date().toISOString(),
      },
      tasks: [] satisfies CronTask[],
    }),
  );
  const logged: string[] = [];
  const onLog = mock((message: string) => {
    logged.push(message);
  });
  const opts: StartListenerOptions = {
    connectionId: "conn-test",
    wsUrl: "wss://example.test/ws",
    deviceId: "device-test",
    connectionName: "listener-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
    onLog,
  };

  startScheduler({} as ListenerTransport, opts, async () => {}, 3);

  expect(onLog).toHaveBeenCalledTimes(2);
  expect(logged[0]).toContain(
    "[Cron] Failed to claim scheduler lease after 4 attempts",
  );
  expect(logged[1]).toBe(
    "[Cron] Another process may hold the lease. Restart Letta Code to retry.",
  );
});

test("startScheduler does not arm intervals after the initial tick loses the lease", () => {
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    return handle;
  }) as typeof setInterval;

  try {
    __testFailNextRefreshSchedulerLease();
    const logged: string[] = [];
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-lease-loss",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-lease-loss",
        connectionName: "listener-lease-loss",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(false);
    expect(armed).toHaveLength(0);
    expect(logged.some((line) => line.includes("Scheduler lease lost"))).toBe(
      true,
    );
  } finally {
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped startScheduler heartbeats the mixed-version tombstone between fire ticks", () => {
  const delays: number[] = [];
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    delays.push(Number(args[1] ?? 0));
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-tombstone",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-tombstone",
        connectionName: "listener-tombstone",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    expect(delays).toEqual(expect.arrayContaining([1_000, 60_000]));
    expect(delays).toHaveLength(3);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("tombstone heartbeat logs lock errors without treating them as lease loss", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-heartbeat-lock",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-heartbeat-lock",
        connectionName: "listener-heartbeat-lock",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    expect(heartbeat).toBeTypeOf("function");
    __testThrowNextRefreshSchedulerLease();
    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    expect(
      logged.some((line) =>
        line.includes(
          "Tombstone heartbeat error: Failed to acquire crons.lock",
        ),
      ),
    ).toBe(true);
    expect(logged.some((line) => line.includes("Scheduler lease lost"))).toBe(
      false,
    );
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped heartbeat restores a stripped row beside the sibling tombstone", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const cloudToken = claimSchedulerLease("cloud");
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-sibling-tombstone",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-sibling-tombstone",
        connectionName: "listener-sibling-tombstone",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    const before = readCronFile();
    expect(before.scheduler_owner?.token).toBe(cloudToken);
    writeFileSync(
      path.join(TEST_DIR, "crons.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: before.scheduler_owner,
        tasks: [],
      }),
    );

    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    const after = readCronFile();
    expect(after.scheduler_owners.local).toEqual(
      expect.objectContaining({ pid: process.pid }),
    );
    expect(after.scheduler_owner?.token).toBe(cloudToken);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("scoped heartbeat does not restore beside a live all-owner", () => {
  let heartbeat: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const logged: string[] = [];
  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-all-owner",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-all-owner",
        connectionName: "listener-all-owner",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
        onLog: (message: string) => {
          logged.push(message);
        },
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    writeFileSync(
      path.join(TEST_DIR, "crons.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: {
          pid: process.pid,
          token: "legacy-all-owner",
          started_at: new Date().toISOString(),
        },
        tasks: [],
      }),
    );

    heartbeat?.();

    expect(isSchedulerRunning()).toBe(true);
    expect(readCronFile().scheduler_owners).toEqual({});
    expect(
      logged.some((line) => line.includes("Scheduler lease lost; retrying")),
    ).toBe(true);
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

test("unleased scoped retry clears jitter timers and does not fire", () => {
  let heartbeat: (() => void) | undefined;
  let jitterFire: (() => void) | undefined;
  const armed: ReturnType<typeof setInterval>[] = [];
  const realSetInterval = globalThis.setInterval;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let clearedJitter = false;

  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = realSetInterval(...args);
    armed.push(handle);
    if (Number(args[1] ?? 0) === 1_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        heartbeat = handler as () => void;
      }
    }
    return handle;
  }) as typeof setInterval;
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
    const handle = realSetTimeout(...args);
    if (Number(args[1] ?? 0) === 30_000) {
      const handler = args[0];
      if (typeof handler === "function") {
        jitterFire = handler as () => void;
      }
    }
    return handle;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((
    handle: Parameters<typeof realClearTimeout>[0],
  ) => {
    if (jitterFire) clearedJitter = true;
    realClearTimeout(handle);
  }) as typeof clearTimeout;

  process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
  const { task } = addTask(
    makeInput({
      agent_id: "agent-local-jitter",
      cron: "* * * * *",
    }),
  );
  updateTask(task.id, (t) => {
    t.jitter_offset_ms = 30_000;
  });

  try {
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-jitter-unleased",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-jitter-unleased",
        connectionName: "listener-jitter-unleased",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(isSchedulerRunning()).toBe(true);
    expect(jitterFire).toBeTypeOf("function");
    expect(getTask(task.id)?.last_run_outcome).toBeNull();

    const current = readCronFile();
    writeFileSync(
      path.join(TEST_DIR, "crons.json"),
      JSON.stringify({
        version: 1,
        scheduler_owner: {
          pid: process.pid,
          token: "legacy-all-owner",
          started_at: new Date().toISOString(),
        },
        tasks: current.tasks,
      }),
    );

    heartbeat?.();
    expect(isSchedulerRunning()).toBe(true);
    expect(clearedJitter).toBe(true);

    jitterFire?.();
    expect(getTask(task.id)?.last_run_outcome).toBeNull();
  } finally {
    stopScheduler();
    globalThis.setInterval = realSetInterval;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    for (const handle of armed) {
      clearInterval(handle);
    }
  }
});

// ── Helper ──────────────────────────────────────────────────────────

function makeInput(overrides: Partial<AddTaskInput> = {}): AddTaskInput {
  return {
    agent_id: "agent-test-001",
    conversation_id: "default",
    name: "Test task",
    description: "A test cron task",
    prompt: "echo hello",
    cron: "*/5 * * * *",
    recurring: true,
    ...overrides,
  };
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function expectedLocalTimezoneSuffix(): string {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timezone) return "local";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return timezone;
  } catch {
    return "local";
  }
}

function formatExpectedLocalIso(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffset = Math.abs(offsetMinutes);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1, 2)}-${pad(date.getDate(), 2)}T${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(absOffset / 60), 2)}:${pad(absOffset % 60, 2)}[${expectedLocalTimezoneSuffix()}]`;
}

// ── shouldFireTask logic tests ──────────────────────────────────────

describe("shouldFireTask (cron matching logic)", () => {
  test("recurring task matches at correct minute", () => {
    const { task } = addTask(makeInput({ cron: "30 14 * * *" }));

    // Simulate fire check at 14:30
    const match = cronMatchesTime(task.cron, new Date("2026-03-26T14:30:00"));
    expect(match).toBe(true);
  });

  test("recurring task does not match at wrong minute", () => {
    const { task } = addTask(makeInput({ cron: "30 14 * * *" }));

    const match = cronMatchesTime(task.cron, new Date("2026-03-26T14:31:00"));
    expect(match).toBe(false);
  });

  test("step cron matches multiples", () => {
    const { task } = addTask(makeInput({ cron: "*/5 * * * *" }));

    expect(cronMatchesTime(task.cron, new Date("2026-03-26T14:00:00"))).toBe(
      true,
    );
    expect(cronMatchesTime(task.cron, new Date("2026-03-26T14:05:00"))).toBe(
      true,
    );
    expect(cronMatchesTime(task.cron, new Date("2026-03-26T14:10:00"))).toBe(
      true,
    );
    expect(cronMatchesTime(task.cron, new Date("2026-03-26T14:03:00"))).toBe(
      false,
    );
  });

  test("one-shot task has scheduled_for field", () => {
    const scheduledFor = new Date(Date.now() + 5 * 60 * 1000);
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: scheduledFor,
      }),
    );

    expect(task.recurring).toBe(false);
    expect(task.scheduled_for).toBeTruthy();
    // The stored cron should be a valid 5-field expression
    expect(task.cron.split(" ")).toHaveLength(5);
  });
});

// ── Deduplication logic tests ───────────────────────────────────────

describe("per-minute deduplication", () => {
  test("minute key format is consistent", () => {
    const date = new Date("2026-03-26T14:30:00Z");
    const minuteKey = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}`;
    expect(minuteKey).toBe("2026-03-26T14:30");
  });

  test("same minute generates same key", () => {
    const d1 = new Date("2026-03-26T14:30:00Z");
    const d2 = new Date("2026-03-26T14:30:45Z");
    const key1 = `${d1.getUTCFullYear()}-${String(d1.getUTCMonth() + 1).padStart(2, "0")}-${String(d1.getUTCDate()).padStart(2, "0")}T${String(d1.getUTCHours()).padStart(2, "0")}:${String(d1.getUTCMinutes()).padStart(2, "0")}`;
    const key2 = `${d2.getUTCFullYear()}-${String(d2.getUTCMonth() + 1).padStart(2, "0")}-${String(d2.getUTCDate()).padStart(2, "0")}T${String(d2.getUTCHours()).padStart(2, "0")}:${String(d2.getUTCMinutes()).padStart(2, "0")}`;
    expect(key1).toBe(key2);
  });

  test("different minutes generate different keys", () => {
    const d1 = new Date("2026-03-26T14:30:00Z");
    const d2 = new Date("2026-03-26T14:31:00Z");
    const key1 = `${d1.getUTCFullYear()}-${String(d1.getUTCMonth() + 1).padStart(2, "0")}-${String(d1.getUTCDate()).padStart(2, "0")}T${String(d1.getUTCHours()).padStart(2, "0")}:${String(d1.getUTCMinutes()).padStart(2, "0")}`;
    const key2 = `${d2.getUTCFullYear()}-${String(d2.getUTCMonth() + 1).padStart(2, "0")}-${String(d2.getUTCDate()).padStart(2, "0")}T${String(d2.getUTCHours()).padStart(2, "0")}:${String(d2.getUTCMinutes()).padStart(2, "0")}`;
    expect(key1).not.toBe(key2);
  });
});

describe("scheduler backend scope", () => {
  const cloudTask = { agent_id: "agent-cloud" } as CronTask;
  const localTask = {
    agent_id: "agent-local-123",
  } as CronTask;

  test("defaults to all schedules for standalone listeners", () => {
    expect(resolveCronSchedulerScope(undefined)).toBe("all");
    expect(taskMatchesCronSchedulerScope(cloudTask, "all")).toBe(true);
    expect(taskMatchesCronSchedulerScope(localTask, "all")).toBe(true);
  });

  test("partitions cloud and local agent schedules", () => {
    expect(resolveCronSchedulerScope("cloud")).toBe("cloud");
    expect(resolveCronSchedulerScope("local")).toBe("local");
    expect(taskMatchesCronSchedulerScope(cloudTask, "cloud")).toBe(true);
    expect(taskMatchesCronSchedulerScope(localTask, "cloud")).toBe(false);
    expect(taskMatchesCronSchedulerScope(cloudTask, "local")).toBe(false);
    expect(taskMatchesCronSchedulerScope(localTask, "local")).toBe(true);
  });

  test("startScheduler with local scope does not fire a cloud-agent schedule", async () => {
    const dueAt = new Date(Date.now() - 30_000);
    const cloud = addTask(
      makeInput({
        agent_id: "agent-cloud-001",
        recurring: false,
        scheduled_for: dueAt,
        cron: "0 0 1 1 *",
      }),
    ).task;
    const local = addTask(
      makeInput({
        agent_id: "agent-local-abc",
        recurring: false,
        scheduled_for: dueAt,
        cron: "0 0 1 1 *",
      }),
    ).task;

    process.env[CRON_SCHEDULER_SCOPE_ENV] = "local";
    startScheduler(
      {} as ListenerTransport,
      {
        connectionId: "conn-scope",
        wsUrl: "wss://example.test/ws",
        deviceId: "device-scope",
        connectionName: "listener-scope",
        onConnected: () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
      async () => {},
    );

    expect(getTask(cloud.id)).toMatchObject({
      status: "active",
      fire_count: 0,
      last_run_outcome: null,
    });

    const deadline = Date.now() + 1000;
    while (
      Date.now() < deadline &&
      getTask(local.id)?.last_run_outcome == null
    ) {
      await Bun.sleep(10);
    }

    expect(getTask(local.id)).toMatchObject({
      last_run_outcome: "failed",
      last_run_reason: "runtime_unavailable",
    });
    expect(getTask(cloud.id)).toMatchObject({
      status: "active",
      fire_count: 0,
      last_run_outcome: null,
    });
  });
});

// ── Task lifecycle tests ────────────────────────────────────────────

describe("task lifecycle", () => {
  test("delayed recurring prompt keeps Scheduled for at matched minute and Current time later", () => {
    const { task } = addTask(
      makeInput({ cron: "5 0 * * *", timezone: "America/St_Johns" }),
    );
    const taskAtFire = { ...task, fire_count: 7 };
    const intendedOccurrence = getIntendedCronOccurrence(
      taskAtFire,
      new Date("2026-06-01T02:35:17.999Z"),
    );
    const schedulerNow = new Date("2026-06-01T02:35:42.123Z");

    expect(
      wrapCronPrompt(taskAtFire, { intendedOccurrence, schedulerNow }),
    ).toBe(
      [
        'Scheduled task "Test task" is firing.',
        "Description: A test cron task",
        "Timezone: America/St_Johns",
        "Scheduled for: 2026-06-01T00:05:00.000-02:30[America/St_Johns]",
        "Current time: 2026-06-01T00:05:42.123-02:30[America/St_Johns]",
        "This is fire #8 (cron: 5 0 * * *).",
        "",
        "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.",
        "",
        "Prompt: echo hello",
      ].join("\n"),
    );
    expect(
      wrapCronPrompt(taskAtFire, { intendedOccurrence, schedulerNow }),
    ).not.toContain("<system-reminder>");
  });

  test("cron prompt includes intended one-shot occurrence near local midnight", () => {
    const scheduledFor = new Date("2026-01-01T18:20:30.456Z");
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: scheduledFor,
        timezone: "Asia/Kathmandu",
      }),
    );
    const schedulerNow = new Date("2026-01-01T18:19:45.000Z");
    const intendedOccurrence = getIntendedCronOccurrence(task, schedulerNow);

    expect(wrapCronPrompt(task, { intendedOccurrence, schedulerNow })).toBe(
      [
        'Scheduled task "Test task" is firing.',
        "Description: A test cron task",
        "Timezone: Asia/Kathmandu",
        "Scheduled for: 2026-01-02T00:05:30.456+05:45[Asia/Kathmandu]",
        "Current time: 2026-01-02T00:04:45.000+05:45[Asia/Kathmandu]",
        "This is a one-off scheduled task.",
        "",
        "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.",
        "",
        "Prompt: echo hello",
      ].join("\n"),
    );
  });

  test("cron prompt falls back to local time for legacy invalid timezones", () => {
    const { task } = addTask(
      makeInput({ cron: "5 0 * * *", timezone: "Not/A_Zone" }),
    );
    const matchedAt = new Date("2026-06-01T02:35:17.999Z");
    const schedulerNow = new Date("2026-06-01T02:35:42.123Z");
    const intendedOccurrence = getIntendedCronOccurrence(task, matchedAt);

    const prompt = wrapCronPrompt(task, { intendedOccurrence, schedulerNow });

    expect(prompt).toContain(
      "Timezone: Not/A_Zone (invalid; using local time)",
    );
    expect(prompt).toContain(
      `Scheduled for: ${formatExpectedLocalIso(intendedOccurrence)}`,
    );
    expect(prompt).toContain(
      `Current time: ${formatExpectedLocalIso(schedulerNow)}`,
    );
  });

  test("WS wrapper and TUI shared formatter produce identical prompt text", () => {
    const { task } = addTask(
      makeInput({ cron: "30 23 * * *", timezone: "Europe/Paris" }),
    );
    const timing = {
      intendedOccurrence: getIntendedCronOccurrence(
        task,
        new Date("2026-03-27T22:30:59.999Z"),
      ),
      schedulerNow: new Date("2026-03-27T22:31:08.250Z"),
    };

    expect(formatCronPrompt(task, timing)).toBe(wrapCronPrompt(task, timing));
  });

  test("new recurring task starts with fire_count 0", () => {
    const { task } = addTask(makeInput());
    expect(task.fire_count).toBe(0);
    expect(task.last_fired_at).toBeNull();
  });

  test("persisted invalid recurring tasks expose one durable failure", () => {
    const { task } = addTask(makeInput());
    const data = readCronFile();
    const persistedTask = data.tasks.find(
      (candidate) => candidate.id === task.id,
    );
    if (!persistedTask) throw new Error("expected persisted cron task");
    persistedTask.cron = "0-60 * * * *";
    writeFileSync(
      path.join(TEST_DIR, "crons.json"),
      JSON.stringify(data, null, 2),
    );
    const persisted = getTask(task.id);
    if (!persisted) throw new Error("expected persisted cron task");
    const checkedAt = new Date("2026-03-26T14:30:00Z");

    expect(handleTaskPreflight(persisted, checkedAt)).toBe(true);

    const updated = getTask(task.id);
    expect(updated).toEqual(
      expect.objectContaining({
        status: "active",
        last_run_at: checkedAt.toISOString(),
        last_run_outcome: "failed",
        last_run_reason: "invalid_cron",
        last_run_error:
          'Invalid cron expression "0-60 * * * *". Delete and recreate this schedule.',
        failed_count: 1,
      }),
    );
    expect(
      readCronRunLogEntries(getCronRunLogPath(task.id), {
        jobId: task.id,
        limit: 10,
      }),
    ).toEqual([
      expect.objectContaining({
        status: "error",
        outcome: "failed",
        reason: "invalid_cron",
      }),
    ]);

    if (!updated) throw new Error("expected updated cron task");
    expect(handleTaskPreflight(updated, checkedAt)).toBe(true);
    expect(getTask(task.id)?.failed_count).toBe(1);
    expect(
      readCronRunLogEntries(getCronRunLogPath(task.id), {
        jobId: task.id,
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  test("new one-shot task starts with status active", () => {
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: new Date(Date.now() + 60000),
      }),
    );
    expect(task.status).toBe("active");
    expect(task.fired_at).toBeNull();
  });

  test("one-shot task has jitter_offset_ms field", () => {
    const scheduledFor = new Date();
    scheduledFor.setMinutes(0, 0, 0); // :00 triggers jitter
    scheduledFor.setTime(scheduledFor.getTime() + 60 * 60 * 1000); // 1 hour in future
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: scheduledFor,
      }),
    );
    // jitter_offset_ms should be a number (may be 0 or negative for :00/:30)
    expect(typeof task.jitter_offset_ms).toBe("number");
  });

  test("missed one-shot writes a skipped run log", () => {
    const scheduledFor = new Date(Date.now() - 10 * 60 * 1000);
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: scheduledFor,
      }),
    );

    expect(handleMissedOneShot(task, new Date())).toBe(true);

    const entries = readCronRunLogEntries(getCronRunLogPath(task.id), {
      jobId: task.id,
      limit: 10,
    });
    expect(entries).toEqual([
      expect.objectContaining({
        jobId: task.id,
        status: "skipped",
        outcome: "missed",
        reason: "scheduler_inactive",
        summary: "missed",
        scheduledFor: scheduledFor.toISOString(),
        missedCount: 1,
      }),
    ]);
  });
});

// ── Delayed-fire revalidation tests ─────────────────────────────────

describe("jitter revalidation guards", () => {
  test("deleted task is not found by getTask (revalidation would skip fire)", () => {
    const { task } = addTask(makeInput());
    expect(getTask(task.id)).not.toBeNull();

    // Simulate deletion during jitter window
    deleteTask(task.id);
    expect(getTask(task.id)).toBeNull();
  });

  test("paused task fails the fresh active-status check during jitter", () => {
    const { task } = addTask(makeInput());
    expect(task.status).toBe("active");

    expect(pauseTask(task.id).success).toBe(true);

    const fresh = getTask(task.id);
    expect(fresh?.status).toBe("paused");
    expect(fresh?.status === "active").toBe(false);
  });

  test("cancelled task has non-active status (revalidation would skip fire)", () => {
    const { task } = addTask(makeInput());
    expect(task.status).toBe("active");

    updateTask(task.id, (t) => {
      t.status = "cancelled";
    });
    const fresh = getTask(task.id);
    expect(fresh?.status).toBe("cancelled");
  });

  test("fired one-shot has non-active status (revalidation would skip fire)", () => {
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: new Date(Date.now() + 60000),
      }),
    );
    expect(task.status).toBe("active");

    // Simulate one-shot being marked as fired during jitter window
    updateTask(task.id, (t) => {
      t.status = "fired";
      t.fired_at = new Date().toISOString();
    });
    const fresh = getTask(task.id);
    expect(fresh?.status).toBe("fired");
  });
});
