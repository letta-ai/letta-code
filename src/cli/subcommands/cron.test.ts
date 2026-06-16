import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runCronSubcommand } from "@/cli/subcommands/cron";
import {
  type AddTaskInput,
  addTask,
  getTask,
  updateTask,
} from "@/cron/cron-file";

const TEST_DIR = path.join(import.meta.dir, "__cron_cli_test_tmp__");
const origHome = process.env.LETTA_HOME;
const origXdg = process.env.XDG_CONFIG_HOME;

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
  if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
  else delete process.env.XDG_CONFIG_HOME;
});

function makeInput(overrides: Partial<AddTaskInput> = {}): AddTaskInput {
  return {
    agent_id: "agent-test-001",
    conversation_id: "default",
    name: "Test task",
    description: "A test cron task",
    prompt: "original prompt",
    cron: "*/5 * * * *",
    recurring: true,
    ...overrides,
  };
}

async function runCron(argv: string[]): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (message?: unknown) => {
    logs.push(String(message ?? ""));
  };
  console.error = (message?: unknown) => {
    errors.push(String(message ?? ""));
  };

  try {
    const exitCode = await runCronSubcommand(argv);
    return {
      exitCode,
      stdout: logs.join("\n"),
      stderr: errors.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

function parseJson<T>(stdout: string): T {
  return JSON.parse(stdout) as T;
}

function markRunMetadata(taskId: string): void {
  updateTask(taskId, (task) => {
    task.fire_count = 7;
    task.last_fired_at = "2026-01-01T00:00:00.000Z";
    task.last_run_at = "2026-01-01T00:00:01.000Z";
    task.last_run_outcome = "queued";
    task.last_run_reason = "scheduled_time_matched";
    task.last_run_error = "kept for regression coverage";
    task.last_missed_at = "2026-01-01T00:01:00.000Z";
    task.missed_count = 2;
    task.failed_count = 1;
  });
}

describe("letta cron update", () => {
  test("updates prompt in place and preserves run metadata", async () => {
    const { task } = addTask(makeInput());
    markRunMetadata(task.id);

    const result = await runCron([
      "update",
      task.id,
      "--prompt",
      "updated prompt",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const output = parseJson<typeof task>(result.stdout);
    expect(output.id).toBe(task.id);
    expect(output.prompt).toBe("updated prompt");
    expect(output.fire_count).toBe(7);
    expect(output.last_fired_at).toBe("2026-01-01T00:00:00.000Z");
    expect(output.last_run_outcome).toBe("queued");
    expect(output.missed_count).toBe(2);
    expect(getTask(task.id)?.prompt).toBe("updated prompt");
  });

  test("updates prompt from --prompt-file", async () => {
    const { task } = addTask(makeInput());
    const promptPath = path.join(TEST_DIR, "prompt.txt");
    writeFileSync(promptPath, "from file\nwith context", "utf8");

    const result = await runCron([
      "update",
      task.id,
      "--prompt-file",
      promptPath,
    ]);

    expect(result.exitCode).toBe(0);
    const output = parseJson<typeof task>(result.stdout);
    expect(output.id).toBe(task.id);
    expect(output.prompt).toBe("from file\nwith context");
    expect(getTask(task.id)?.prompt).toBe("from file\nwith context");
  });

  test("updates recurring cron schedule without changing task identity", async () => {
    const { task } = addTask(makeInput());
    markRunMetadata(task.id);

    const result = await runCron(["update", task.id, "--cron", "0 9 * * 1-5"]);

    expect(result.exitCode).toBe(0);
    const output = parseJson<typeof task>(result.stdout);
    expect(output.id).toBe(task.id);
    expect(output.created_at).toBe(task.created_at);
    expect(output.cron).toBe("0 9 * * 1-5");
    expect(output.recurring).toBe(true);
    expect(output.scheduled_for).toBeNull();
    expect(output.fire_count).toBe(7);
    expect(getTask(task.id)?.cron).toBe("0 9 * * 1-5");
  });

  test("updates a task to a one-shot schedule", async () => {
    const { task } = addTask(makeInput());
    const before = Date.now();

    const result = await runCron(["update", task.id, "--at", "in 30m"]);

    expect(result.exitCode).toBe(0);
    const output = parseJson<typeof task>(result.stdout);
    expect(output.id).toBe(task.id);
    expect(output.recurring).toBe(false);
    expect(output.scheduled_for).not.toBeNull();
    expect(new Date(output.scheduled_for ?? "").getTime()).toBeGreaterThan(
      before,
    );
    expect(output.cron.split(/\s+/)).toHaveLength(5);
    expect(getTask(task.id)?.recurring).toBe(false);
  });

  test("updates name, description, conversation, and timezone", async () => {
    const { task } = addTask(makeInput());

    const result = await runCron([
      "update",
      task.id,
      "--name",
      "renamed task",
      "--description",
      "new description",
      "--conversation",
      "conversation-123",
      "--timezone",
      "America/Los_Angeles",
    ]);

    expect(result.exitCode).toBe(0);
    const output = parseJson<typeof task>(result.stdout);
    expect(output.id).toBe(task.id);
    expect(output.name).toBe("renamed task");
    expect(output.description).toBe("new description");
    expect(output.conversation_id).toBe("conversation-123");
    expect(output.timezone).toBe("America/Los_Angeles");
    expect(getTask(task.id)?.timezone).toBe("America/Los_Angeles");
  });

  test("rejects invalid cron expressions without mutating the task", async () => {
    const { task } = addTask(makeInput());
    const before = getTask(task.id);

    const result = await runCron(["update", task.id, "--cron", "not a cron"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("invalid cron expression");
    expect(getTask(task.id)).toEqual(before);
  });

  test("requires a task ID", async () => {
    const result = await runCron(["update", "--prompt", "updated"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("task ID required");
  });
});
