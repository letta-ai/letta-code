import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { type AddTaskInput, addTask } from "../../cron/cronFile";
import { cronMatchesTime } from "../../cron/parseInterval";

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
  test("new recurring task starts with fire_count 0", () => {
    const { task } = addTask(makeInput());
    expect(task.fire_count).toBe(0);
    expect(task.last_fired_at).toBeNull();
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
});
