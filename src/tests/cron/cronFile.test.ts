import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  __testOverrideReadProcessIdentity,
  type AddTaskInput,
  addTask,
  claimSchedulerLease,
  computeJitter,
  deleteAllTasks,
  deleteTask,
  garbageCollect,
  getActiveTasks,
  getTask,
  listTasks,
  readCronFile,
  releaseSchedulerLease,
  updateTask,
  verifySchedulerLease,
  withLock,
} from "../../cron/cronFile";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__cron_test_tmp__");
const _CRON_PATH = path.join(TEST_DIR, "crons.json");
const _LOCK_PATH = path.join(TEST_DIR, "crons.lock");

// Override the internal paths used by cronFile.ts for testing.
// We need to use the module's own path resolution, so we'll set
// LETTA_HOME to point to our test directory.
const origHome = process.env.LETTA_HOME;
const origXdg = process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  // Point LETTA_HOME to test dir so cronFile uses our temp path
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  // Note: cronFile.ts reads from ~/.letta/crons.json.
  // For unit tests we need to test the pure logic functions.
  // We'll test addTask/listTasks/deleteTask through the public API
  // by setting LETTA_HOME.
  process.env.LETTA_HOME = TEST_DIR;
});

afterEach(() => {
  __testOverrideReadProcessIdentity(null);
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.LETTA_HOME = origHome;
  else delete process.env.LETTA_HOME;
  if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
  else delete process.env.XDG_CONFIG_HOME;
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

// ── Tests ───────────────────────────────────────────────────────────

describe("addTask", () => {
  test("creates a new recurring task", () => {
    const result = addTask(makeInput());
    expect(result.task).toBeDefined();
    expect(result.task.id).toMatch(/^[0-9a-f]+$/);
    expect(result.task.status).toBe("active");
    expect(result.task.recurring).toBe(true);
    expect(result.task.fire_count).toBe(0);
    expect(result.task.cron).toBe("*/5 * * * *");
  });

  test("creates a one-shot task", () => {
    const scheduledFor = new Date(Date.now() + 60000);
    const result = addTask(
      makeInput({
        recurring: false,
        scheduled_for: scheduledFor,
      }),
    );
    expect(result.task.recurring).toBe(false);
    expect(result.task.scheduled_for).toBe(scheduledFor.toISOString());
  });

  test("multiple tasks get unique IDs", () => {
    const r1 = addTask(makeInput());
    const r2 = addTask(makeInput({ prompt: "echo world" }));
    expect(r1.task.id).not.toBe(r2.task.id);
  });
});

describe("listTasks", () => {
  test("lists all tasks", () => {
    addTask(makeInput());
    addTask(makeInput({ prompt: "echo world" }));
    const tasks = listTasks();
    expect(tasks).toHaveLength(2);
  });

  test("filters by agent_id", () => {
    addTask(makeInput({ agent_id: "agent-a" }));
    addTask(makeInput({ agent_id: "agent-b" }));
    const tasks = listTasks({ agent_id: "agent-a" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.agent_id).toBe("agent-a");
  });

  test("getActiveTasks filters by active status", () => {
    addTask(makeInput());
    const t2 = addTask(
      makeInput({
        recurring: false,
        scheduled_for: new Date(Date.now() + 60000),
      }),
    );
    // Mark second as cancelled
    updateTask(t2.task.id, (t) => {
      t.status = "cancelled";
    });
    const active = getActiveTasks();
    expect(active).toHaveLength(1);
  });
});

describe("getTask", () => {
  test("returns task by ID", () => {
    const { task } = addTask(makeInput());
    const fetched = getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe(task.id);
  });

  test("returns null for unknown ID", () => {
    expect(getTask("cron_nonexistent")).toBeNull();
  });
});

describe("deleteTask", () => {
  test("deletes existing task", () => {
    const { task } = addTask(makeInput());
    const deleted = deleteTask(task.id);
    expect(deleted).toBe(true);
    expect(getTask(task.id)).toBeNull();
  });

  test("returns false for unknown ID", () => {
    expect(deleteTask("cron_nonexistent")).toBe(false);
  });
});

describe("deleteAllTasks", () => {
  test("deletes all tasks for an agent", () => {
    addTask(makeInput({ agent_id: "agent-a" }));
    addTask(makeInput({ agent_id: "agent-a", prompt: "echo 2" }));
    addTask(makeInput({ agent_id: "agent-b" }));
    const count = deleteAllTasks("agent-a");
    expect(count).toBe(2);
    expect(listTasks({ agent_id: "agent-a" })).toHaveLength(0);
    expect(listTasks({ agent_id: "agent-b" })).toHaveLength(1);
  });
});

describe("updateTask", () => {
  test("mutates task in place", () => {
    const { task } = addTask(makeInput());
    updateTask(task.id, (t) => {
      t.fire_count = 5;
      t.last_fired_at = "2026-01-01T00:00:00Z";
    });
    const updated = getTask(task.id);
    expect(updated?.fire_count).toBe(5);
    expect(updated?.last_fired_at).toBe("2026-01-01T00:00:00Z");
  });
});

describe("getActiveTasks", () => {
  test("returns only active tasks", () => {
    addTask(makeInput());
    const t2 = addTask(makeInput({ prompt: "echo world" }));
    updateTask(t2.task.id, (t) => {
      t.status = "cancelled";
    });
    const active = getActiveTasks();
    expect(active).toHaveLength(1);
  });
});

describe("scheduler lease", () => {
  test("claim and verify", () => {
    const token = claimSchedulerLease();
    expect(token).toBeTruthy();
    expect(verifySchedulerLease(token)).toBe(true);
  });

  test("release", () => {
    const token = claimSchedulerLease();
    releaseSchedulerLease(token);
    expect(verifySchedulerLease(token)).toBe(false);
  });

  test("wrong token fails verification", () => {
    claimSchedulerLease();
    expect(verifySchedulerLease("wrong-token")).toBe(false);
  });

  test("takes over a stale lease when the same PID belongs to a different process incarnation", () => {
    __testOverrideReadProcessIdentity((pid) =>
      pid === process.pid ? { startTicks: "200", bootId: "boot-a" } : null,
    );

    writeFileSync(
      _CRON_PATH,
      JSON.stringify(
        {
          version: 1,
          scheduler_owner: {
            pid: process.pid,
            token: "stale-token",
            started_at: "2026-04-15T00:00:00.000Z",
            process_start_ticks: "100",
            boot_id: "boot-a",
          },
          tasks: [],
        },
        null,
        2,
      ),
    );

    const token = claimSchedulerLease();
    const owner = readCronFile().scheduler_owner;

    expect(token).not.toBe("stale-token");
    expect(owner).toEqual(
      expect.objectContaining({
        pid: process.pid,
        token,
        process_start_ticks: "200",
        boot_id: "boot-a",
      }),
    );
  });
});

describe("garbageCollect", () => {
  test("removes old fired one-shot tasks", () => {
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: new Date(Date.now() + 60000),
      }),
    );
    // Mark as fired with old timestamps (both created_at and fired_at must be old for GC)
    updateTask(task.id, (t) => {
      t.status = "fired";
      const twoDaysAgo = new Date(
        Date.now() - 2 * 24 * 60 * 60 * 1000,
      ).toISOString();
      t.created_at = twoDaysAgo;
      t.fired_at = twoDaysAgo;
    });
    const removed = garbageCollect();
    expect(removed).toBe(1);
    expect(getTask(task.id)).toBeNull();
  });

  test("keeps recent fired tasks", () => {
    const { task } = addTask(
      makeInput({
        recurring: false,
        scheduled_for: new Date(Date.now() + 60000),
      }),
    );
    updateTask(task.id, (t) => {
      t.status = "fired";
      t.fired_at = new Date().toISOString(); // just now
    });
    const removed = garbageCollect();
    expect(removed).toBe(0);
    expect(getTask(task.id)).not.toBeNull();
  });
});

describe("withLock", () => {
  test("executes function under lock", () => {
    let executed = false;
    withLock(() => {
      executed = true;
    });
    expect(executed).toBe(true);
  });

  test("returns function result", () => {
    const result = withLock(() => 42);
    expect(result).toBe(42);
  });

  test("steals a stale lock when the PID was recycled to a different process", () => {
    __testOverrideReadProcessIdentity((pid) =>
      pid === process.pid ? { startTicks: "200", bootId: "boot-a" } : null,
    );

    mkdirSync(_LOCK_PATH, { recursive: true });
    writeFileSync(
      path.join(_LOCK_PATH, "owner.json"),
      JSON.stringify({
        pid: process.pid,
        token: "stale-lock",
        acquired_at: Date.now() - 31_000,
        process_start_ticks: "100",
        boot_id: "boot-a",
      }),
    );

    let executed = false;
    withLock(() => {
      executed = true;
    });

    expect(executed).toBe(true);
  });

  test("matching process identity keeps the scheduler warning suppressed", () => {
    __testOverrideReadProcessIdentity((pid) =>
      pid === process.pid ? { startTicks: "200", bootId: "boot-a" } : null,
    );

    writeFileSync(
      _CRON_PATH,
      JSON.stringify(
        {
          version: 1,
          scheduler_owner: {
            pid: process.pid,
            token: "live-token",
            started_at: "2026-04-15T00:00:00.000Z",
            process_start_ticks: "200",
            boot_id: "boot-a",
          },
          tasks: [],
        },
        null,
        2,
      ),
    );

    const result = addTask(makeInput({ prompt: "echo live scheduler" }));
    expect(result.warning).toBeUndefined();
  });
});

// ── computeJitter ─────────────────────────────────────────────────

describe("computeJitter", () => {
  const now = new Date("2026-03-26T00:00:00Z");

  test("recurring jitter is always < 60s", () => {
    // Hourly cron: period=3600s, 10% = 360s, but cap at 59999ms
    const jitter = computeJitter(
      "test-hourly-task",
      "0 * * * *",
      true,
      null,
      now,
    );
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(60_000);
  });

  test("recurring jitter for daily cron is < 60s", () => {
    // Daily: period=86400s, 10% = 8640s, but cap at 59999ms
    const jitter = computeJitter(
      "test-daily-task",
      "30 9 * * *",
      true,
      null,
      now,
    );
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(60_000);
  });

  test("recurring jitter for frequent cron stays small", () => {
    // Every 5 min: period=300s, 10% = 30s < 60s → no cap needed
    const jitter = computeJitter(
      "test-5m-task",
      "*/5 * * * *",
      true,
      null,
      now,
    );
    expect(jitter).toBeGreaterThanOrEqual(0);
    expect(jitter).toBeLessThan(30_000); // 10% of 300s = 30s
  });

  test("one-shot at :00 gets negative jitter up to 90s", () => {
    const scheduledFor = new Date("2026-03-27T14:00:00Z");
    const jitter = computeJitter(
      "test-oneshot",
      "0 14 * * *",
      false,
      scheduledFor,
      now,
    );
    expect(jitter).toBeLessThanOrEqual(0);
    expect(jitter).toBeGreaterThanOrEqual(-90_000);
  });

  test("one-shot at non-:00/:30 minute gets zero jitter", () => {
    const scheduledFor = new Date("2026-03-27T14:15:00Z");
    const jitter = computeJitter(
      "test-oneshot-15",
      "15 14 * * *",
      false,
      scheduledFor,
      now,
    );
    expect(jitter).toBe(0);
  });
});
