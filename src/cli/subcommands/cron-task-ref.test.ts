import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask } from "@/cron";
import { resolveTaskName } from "./cron-task-ref";

/**
 * Name resolution for `letta cron get`/`delete` (LET-10492).
 *
 * These tests exercise the local execution path, which
 * never touch the network. The cloud branch shares the same match/ambiguity
 * logic and is best-effort by design (failures fall through to the caller's
 * not-found error).
 */

const TEST_DIR = path.join(import.meta.dir, "__cron_task_ref_test_tmp__");

const origHome = process.env.LETTA_HOME;
const origXdg = process.env.XDG_CONFIG_HOME;
const origDaytonaSandboxId = process.env.DAYTONA_SANDBOX_ID;

beforeEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  delete process.env.DAYTONA_SANDBOX_ID;
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
  if (origHome) process.env.LETTA_HOME = origHome;
  else delete process.env.LETTA_HOME;
  if (origXdg) process.env.XDG_CONFIG_HOME = origXdg;
  else delete process.env.XDG_CONFIG_HOME;
  if (origDaytonaSandboxId) {
    process.env.DAYTONA_SANDBOX_ID = origDaytonaSandboxId;
  } else {
    delete process.env.DAYTONA_SANDBOX_ID;
  }
});

function addNamedTask(name: string): string {
  const result = addTask({
    agent_id: "agent-local-test",
    conversation_id: "default",
    name,
    description: `task ${name}`,
    cron: "*/5 * * * *",
    recurring: true,
    prompt: "do the thing",
  });
  return result.task.id;
}

describe("resolveTaskName (local store)", () => {
  test("resolves a unique name to its task id", async () => {
    const id = addNamedTask("nightly-report");

    const resolved = await resolveTaskName("nightly-report", {
      agentId: "agent-local-test",
    });

    expect(resolved).toEqual({ id, store: "local" });
  });

  test("returns null when no task has the name", async () => {
    addNamedTask("nightly-report");

    const resolved = await resolveTaskName("does-not-exist", {
      agentId: "agent-local-test",
    });

    expect(resolved).toBeNull();
  });

  test("reports ambiguity when multiple tasks share the name", async () => {
    const first = addNamedTask("dup-name");
    const second = addNamedTask("dup-name");

    const resolved = await resolveTaskName("dup-name", {
      agentId: "agent-local-test",
    });

    expect(resolved).toEqual({
      ambiguous: [
        { id: first, store: "local" },
        { id: second, store: "local" },
      ],
    });
  });

  test("does not match task ids as names", async () => {
    const id = addNamedTask("some-task");

    // The resolver is name-only; ID addressing is the caller's first pass.
    const resolved = await resolveTaskName(id, {
      agentId: "agent-local-test",
    });

    expect(resolved).toBeNull();
  });
});
