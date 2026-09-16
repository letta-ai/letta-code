import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addTask, getTask, listTasks, updateTask } from "@/cron";
import { buildCronUpdate } from "./cron-update";

describe("cron update patches", () => {
  test("metadata edit does not introduce schedule or routing defaults", () => {
    expect(
      buildCronUpdate({ prompt: "new prompt", runner: "cloud" }).cloud,
    ).toEqual({
      messages: [{ role: "user", content: "new prompt" }],
    });
    expect(buildCronUpdate({ description: "" }).cloud).toEqual({
      description: "",
    });
  });

  test("explicit routing edits differ from omission", () => {
    expect(buildCronUpdate({ computer: "cloud" }).cloud).toEqual({
      target_device_id: null,
    });
    expect(buildCronUpdate({ conversation: "new" }).cloud).toEqual({
      conversation_id: "new",
    });
    expect(buildCronUpdate({ conversation: "default" }).cloud).toEqual({
      conversation_id: "default",
    });
  });

  test("recurring schedule uses the same expression for both stores", () => {
    const result = buildCronUpdate({ every: "2h" });
    expect(result.cloud.schedule).toEqual({
      type: "recurring",
      cron_expression: "0 */2 * * *",
    });
    expect(result.localSchedule).toEqual({
      cron: "0 */2 * * *",
      recurring: true,
      scheduled_for: null,
    });
  });

  test("one-shot uses one absolute timestamp for both stores", () => {
    const result = buildCronUpdate({ at: "in 45m", once: true });
    expect(result.cloud.schedule?.type).toBe("one-time");
    if (result.cloud.schedule?.type !== "one-time")
      throw new Error("Expected one-time schedule");
    expect(result.cloud.schedule.scheduled_at).toBe(
      Date.parse(result.localSchedule?.scheduled_for ?? ""),
    );
  });

  test.each([
    {},
    { once: true },
    { every: "5m", once: true },
    { cron: "* * * * *", at: "in 1h" },
    { cron: "" },
    { every: "nonsense" },
    { at: "nonsense" },
    { prompt: " " },
    { conversation: "" },
    { computer: " " },
    { computer: "cloud", runner: "local" },
    { name: "x", runner: "invalid" },
  ])("rejects invalid or empty edits before resolving a task: %j", (values) => {
    expect(() => buildCronUpdate(values)).toThrow();
  });
});

describe("cron update with the real local store and CLI", () => {
  let home: string;
  const originalHome = process.env.LETTA_HOME;
  const agent = "local-cron-update-test";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "letta-cron-update-"));
    process.env.LETTA_HOME = home;
  });
  afterEach(() => {
    if (originalHome === undefined) delete process.env.LETTA_HOME;
    else process.env.LETTA_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  function create(name = "editable") {
    const result = addTask({
      agent_id: agent,
      conversation_id: "conversation-original",
      name,
      description: "Original description",
      prompt: "Original prompt",
      cron: "0 9 * * *",
      recurring: true,
      timezone: "Asia/Tokyo",
    });
    return result.task;
  }

  function run(...args: string[]) {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import { runCronSubcommand } from "./cron"; process.exitCode = await runCronSubcommand(process.argv.slice(1));',
        "--",
        "update",
        ...args,
        "--runner",
        "local",
        "--agent",
        agent,
      ],
      {
        cwd: import.meta.dir,
        env: { ...process.env, LETTA_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  test("metadata update preserves ID, timezone, routing and run history", () => {
    const created = create();
    updateTask(created.id, (task) => {
      task.fire_count = 7;
      task.last_fired_at = "2026-01-01T00:00:00.000Z";
      task.failed_count = 2;
    });
    const before = getTask(created.id);
    const result = run(
      created.id,
      "--prompt",
      "Revised prompt",
      "--description",
      "",
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ...before,
      prompt: "Revised prompt",
      description: "",
      runner: "local",
    });
    expect(listTasks()).toHaveLength(1);
  });

  test("resolves name before renaming, and rejects ambiguous names", () => {
    const first = create();
    expect(run(first.name, "--name", "renamed").code).toBe(0);
    expect(getTask(first.id)?.name).toBe("renamed");
    const second = create("renamed");
    const result = run("renamed", "--prompt", "must not save");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("multiple tasks");
    expect(getTask(first.id)?.prompt).toBe("Original prompt");
    expect(getTask(second.id)?.prompt).toBe("Original prompt");
  });

  test("invalid edits and missing IDs never create or mutate tasks", () => {
    const task = create();
    for (const args of [
      [task.id],
      [task.id, "--every", "bad"],
      [task.id, "--all"],
      [task.id, "--computer", "cloud"],
      ["missing-id", "--name", "x"],
    ]) {
      expect(run(...args).code).toBe(1);
      expect(getTask(task.id)).toEqual(task);
      expect(listTasks()).toHaveLength(1);
    }
  });

  test("local backend resolves names offline without an explicit runner", () => {
    const task = create();
    const result = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        'import { runCronSubcommand } from "./cron"; process.exitCode = await runCronSubcommand(process.argv.slice(1));',
        "--",
        "update",
        task.name,
        "--name",
        "offline-edited",
        "--agent",
        agent,
      ],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          LETTA_HOME: home,
          LETTA_LOCAL_BACKEND_EXPERIMENTAL: "1",
          LETTA_BASE_URL: "http://127.0.0.1:1",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      id: task.id,
      name: "offline-edited",
      runner: "local",
    });
    expect(getTask(task.id)?.name).toBe("offline-edited");
  });

  test("schedule edits keep paused tasks paused", () => {
    const task = create();
    updateTask(task.id, (candidate) => {
      candidate.status = "paused";
    });
    expect(run(task.id, "--every", "2h").code).toBe(0);
    expect(getTask(task.id)?.status).toBe("paused");
  });

  test("rearming cannot bypass the local active task limit", () => {
    const task = create();
    updateTask(task.id, (candidate) => {
      candidate.status = "fired";
    });
    for (let i = 0; i < 50; i++) create(`active-${i}`);
    const before = getTask(task.id);
    const result = run(task.id, "--at", "in 2h");
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("maximum 50");
    expect(getTask(task.id)).toEqual(before);
  });

  test("rescheduling rearms completed one-shot without clearing history", () => {
    const created = create();
    updateTask(created.id, (task) => {
      task.status = "fired";
      task.recurring = false;
      task.fire_count = 1;
      task.fired_at = "2026-01-01T00:00:00.000Z";
    });
    expect(run(created.id, "--prompt", "still completed").code).toBe(0);
    expect(getTask(created.id)?.status).toBe("fired");
    const result = run(created.id, "--at", "in 2h");
    expect(result.code).toBe(0);
    const updated = JSON.parse(result.stdout);
    expect(updated.status).toBe("active");
    expect(updated.id).toBe(created.id);
    expect(updated.fire_count).toBe(1);
    expect(updated.fired_at).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.timezone).toBe("Asia/Tokyo");
    expect(Date.parse(updated.scheduled_for)).toBeGreaterThan(Date.now());
    expect(run(created.id, "--every", "2h", "--conversation", "new").code).toBe(
      0,
    );
    expect(getTask(created.id)).toMatchObject({
      recurring: true,
      scheduled_for: null,
      timezone: "Asia/Tokyo",
      conversation_id: "new",
    });
  });
});
