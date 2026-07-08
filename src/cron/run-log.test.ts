import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appendCronRunLog,
  DEFAULT_CRON_RUN_LOG_KEEP_LINES,
  DEFAULT_CRON_RUN_LOG_MAX_BYTES,
  getCronRunLogPath,
  readCronRunLogEntries,
  readCronRunLogEntriesPage,
  resolveCronRunLogPath,
} from "@/cron/run-log";

const TEST_DIR = path.join(import.meta.dir, "__run_log_test_tmp__");
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

describe("cron run log", () => {
  test("exports reference retention defaults", () => {
    expect(DEFAULT_CRON_RUN_LOG_MAX_BYTES).toBe(2_000_000);
    expect(DEFAULT_CRON_RUN_LOG_KEEP_LINES).toBe(2_000);
  });

  test("resolves crons.json to sibling runs/<jobId>.jsonl", () => {
    const storePath = path.join(os.tmpdir(), "letta", "crons.json");
    const logPath = resolveCronRunLogPath({ storePath, jobId: "job-1" });
    expect(
      logPath.endsWith(path.join(os.tmpdir(), "letta", "runs", "job-1.jsonl")),
    ).toBe(true);
  });

  test("resolves current LETTA_HOME run log path", () => {
    expect(getCronRunLogPath("job-1")).toBe(
      path.join(TEST_DIR, "runs", "job-1.jsonl"),
    );
  });

  test("rejects unsafe job ids", () => {
    const storePath = path.join(os.tmpdir(), "letta", "crons.json");
    expect(() =>
      resolveCronRunLogPath({ storePath, jobId: "../job-1" }),
    ).toThrow(/invalid cron run log job id/i);
    expect(() =>
      resolveCronRunLogPath({ storePath, jobId: "nested/job-1" }),
    ).toThrow(/invalid cron run log job id/i);
    expect(() =>
      resolveCronRunLogPath({ storePath, jobId: "..\\job-1" }),
    ).toThrow(/invalid cron run log job id/i);
  });

  test("appends JSONL and prunes by line count", () => {
    const logPath = getCronRunLogPath("job-1");
    for (let i = 0; i < 10; i++) {
      appendCronRunLog(
        logPath,
        {
          ts: 1000 + i,
          jobId: "job-1",
          action: "finished",
          status: "ok",
        },
        { maxBytes: 1, keepLines: 3 },
      );
    }

    const lines = readFileSync(logPath, "utf-8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] ?? "{}")).toMatchObject({ ts: 1009 });
  });

  test("reads entries and ignores invalid lines", () => {
    const logPath = getCronRunLogPath("job-1");
    appendCronRunLog(logPath, {
      ts: 1000,
      jobId: "job-1",
      action: "dequeued",
      status: "ok",
      cronRunId: "cron-run-1",
      batchId: "batch-1",
      queueItemId: "q-1",
      queueLenAfter: 0,
    });
    appendCronRunLog(logPath, {
      ts: 2000,
      jobId: "job-1",
      action: "finished",
      status: "error",
      outcome: "failed",
      reason: "queue_full",
      error: "boom",
      runId: "run-2",
    });
    appendCronRunLog(logPath, {
      ts: 3000,
      jobId: "job-2",
      action: "finished",
      status: "skipped",
    });
    appendFileSync(logPath, "not-json\n");
    appendFileSync(logPath, '{"ts":4000,"jobId":"job-1","action":"started"}\n');

    const entries = readCronRunLogEntries(logPath, {
      jobId: "job-1",
      limit: 10,
    });
    expect(entries.map((entry) => entry.ts)).toEqual([1000, 2000]);
    expect(entries[0]).toMatchObject({
      action: "dequeued",
      cronRunId: "cron-run-1",
      batchId: "batch-1",
      queueItemId: "q-1",
      queueLenAfter: 0,
    });
    expect(entries[1]?.error).toBe("boom");
    expect(entries[1]?.outcome).toBe("failed");
    expect(entries[1]?.reason).toBe("queue_full");
  });

  test("reads newest page first and filters by public, backend, or cron run id", () => {
    const logPath = getCronRunLogPath("job-1");
    appendCronRunLog(logPath, {
      ts: 1000,
      jobId: "job-1",
      action: "finished",
      status: "ok",
      runId: "run-1",
      backendRunId: "run-1",
      cronRunId: "cron-run-1",
    });
    appendCronRunLog(logPath, {
      ts: 2000,
      jobId: "job-1",
      action: "finished",
      status: "error",
      runId: "run-2",
      backendRunId: "run-2",
      cronRunId: "cron-run-2",
    });
    appendCronRunLog(logPath, {
      ts: 3000,
      jobId: "job-1",
      action: "backend_run_started",
      status: "ok",
      backendRunId: "backend-only-3",
      cronRunId: "cron-run-3",
    });

    expect(readCronRunLogEntriesPage(logPath, { limit: 1 })).toMatchObject({
      total: 3,
      hasMore: true,
      nextOffset: 1,
      entries: [{ ts: 3000 }],
    });
    expect(
      readCronRunLogEntriesPage(logPath, { runId: "run-1" }).entries,
    ).toEqual([expect.objectContaining({ runId: "run-1", ts: 1000 })]);
    expect(
      readCronRunLogEntriesPage(logPath, { runId: "backend-only-3" }).entries,
    ).toEqual([
      expect.objectContaining({
        action: "backend_run_started",
        backendRunId: "backend-only-3",
        ts: 3000,
      }),
    ]);
    expect(
      readCronRunLogEntriesPage(logPath, { backendRunId: "backend-only-3" })
        .entries,
    ).toEqual([
      expect.objectContaining({
        action: "backend_run_started",
        backendRunId: "backend-only-3",
        ts: 3000,
      }),
    ]);
    expect(
      readCronRunLogEntriesPage(logPath, { runId: "cron-run-2" }).entries,
    ).toEqual([expect.objectContaining({ cronRunId: "cron-run-2", ts: 2000 })]);
    expect(
      readCronRunLogEntriesPage(logPath, { cronRunId: "cron-run-3" }).entries,
    ).toEqual([expect.objectContaining({ cronRunId: "cron-run-3", ts: 3000 })]);
  });
});
