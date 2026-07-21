import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  type AddTaskInput,
  addTask,
  deleteTask,
  getTask,
  updateTask,
} from "@/cron/cron-file";
import { cronMatchesTime } from "@/cron/parse-interval";
import { getCronRunLogPath, readCronRunLogEntries } from "@/cron/run-log";
import {
  handleInvalidRecurringTask,
  handleMissedOneShot,
  wrapCronPrompt,
} from "@/cron/scheduler";

// ── Test setup ──────────────────────────────────────────────────────

const TEST_DIR = path.join(import.meta.dir, "__scheduler_test_tmp__");
const origHome = process.env.LETTA_HOME;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.LETTA_HOME = origHome;
  else delete process.env.LETTA_HOME;
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

// ── Task lifecycle tests ────────────────────────────────────────────

describe("task lifecycle", () => {
  test("cron prompt is visible user message text", () => {
    const { task } = addTask(makeInput());

    expect(wrapCronPrompt(task)).toBe(
      [
        'Scheduled task "Test task" is firing.',
        "Description: A test cron task",
        "This is fire #1 (cron: */5 * * * *).",
        "",
        "You are running autonomously: no user is watching this turn and questions will not be answered. Deliver results through your available channels or record them in memory, and work until the task is done or genuinely blocked.",
        "",
        "Prompt: echo hello",
      ].join("\n"),
    );
    expect(wrapCronPrompt(task)).not.toContain("<system-reminder>");
  });

  test("new recurring task starts with fire_count 0", () => {
    const { task } = addTask(makeInput());
    expect(task.fire_count).toBe(0);
    expect(task.last_fired_at).toBeNull();
  });

  test("persisted invalid recurring tasks expose one durable failure", () => {
    const { task } = addTask(makeInput({ cron: "0-60 * * * *" }));
    const checkedAt = new Date("2026-03-26T14:30:00Z");

    expect(handleInvalidRecurringTask(task, checkedAt)).toBe(true);

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

    if (!updated) throw new Error("expected persisted cron task");
    expect(handleInvalidRecurringTask(updated, checkedAt)).toBe(true);
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

  test("cancelled task has non-active status (revalidation would skip fire)", () => {
    const { task } = addTask(makeInput());
    expect(task.status).toBe("active");

    // Simulate cancellation during jitter window
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
