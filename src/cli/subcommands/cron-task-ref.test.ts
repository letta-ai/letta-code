import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { addTask } from "@/cron";
import { resolveTaskName } from "./cron-task-ref";

/**
 * Name resolution for `letta cron get`/`delete` (LET-10492).
 *
 * These tests exercise the local-store paths (`runner: "local"`), which
 * never touch the network. The cloud branch shares the same match/ambiguity
 * logic and is best-effort by design (failures fall through to the caller's
 * not-found error).
 */

const TEST_DIR = path.join(import.meta.dir, "__cron_task_ref_test_tmp__");

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

function addNamedTask(name: string): string {
  const result = addTask({
    agent_id: "agent-test",
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
      runner: "local",
      agentId: "agent-test",
    });

    expect(resolved).toEqual({ id, store: "local" });
  });

  test("returns null when no task has the name", async () => {
    addNamedTask("nightly-report");

    const resolved = await resolveTaskName("does-not-exist", {
      runner: "local",
      agentId: "agent-test",
    });

    expect(resolved).toBeNull();
  });

  test("reports ambiguity when multiple tasks share the name", async () => {
    const first = addNamedTask("dup-name");
    const second = addNamedTask("dup-name");

    const resolved = await resolveTaskName("dup-name", {
      runner: "local",
      agentId: "agent-test",
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
      runner: "local",
      agentId: "agent-test",
    });

    expect(resolved).toBeNull();
  });

  test("skips the local store when runner is cloud", async () => {
    addNamedTask("cloud-only-lookup");

    // runner: "cloud" skips the local store; the empty agentId also skips
    // the cloud lookup, so nothing matches (and no network call is made).
    const resolved = await resolveTaskName("cloud-only-lookup", {
      runner: "cloud",
      agentId: "",
    });

    expect(resolved).toBeNull();
  });

  test("skips the cloud lookup for local-backend agents", async () => {
    const id = addNamedTask("local-agent-task");

    // agent-local-* ids resolve to the local runner, so no cloud candidate
    // (and no network call) — the local match still wins.
    const resolved = await resolveTaskName("local-agent-task", {
      agentId: "agent-local-123",
    });

    expect(resolved).toEqual({ id, store: "local" });
  });
});
