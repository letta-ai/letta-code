import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  GEMINI_DEFAULT_TOOLS,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
} from "@/tools/manager";
import {
  __resetWorkflowExecutionsForTests,
  getWorkflowExecution,
} from "@/tools/workflow/execution-registry";
import type { SubagentSpawner } from "@/tools/workflow/types";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { backgroundProcesses } from "./process_manager";
import { task_output } from "./task-output";
import { task_stop } from "./task-stop";
import { __setWorkflowSpawnerFactoryForTests, workflow } from "./workflow";

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for workflow state");
    }
    await Bun.sleep(10);
  }
}

const SCRIPT = `export const meta = {
  name: 'simple-demo',
  description: 'Quick demo workflow with parallel agents',
  phases: [{ title: 'Find' }],
}
phase('Find')
log('starting')
const results = await parallel([() => agent('a'), () => agent('b')])
return { count: results.filter(Boolean).length }`;

describe("Workflow tool toolsets", () => {
  test("is exposed wherever Monitor is (Anthropic and Codex PascalCase)", () => {
    expect(ANTHROPIC_DEFAULT_TOOLS).toContain("Workflow");
    expect(OPENAI_PASCAL_TOOLS).toContain("Workflow");
    expect(OPENAI_DEFAULT_TOOLS).not.toContain("Workflow");
    expect(GEMINI_DEFAULT_TOOLS).not.toContain("Workflow");
  });
});

describe("Workflow tool (background launch)", () => {
  let scratchpad: string;
  let previousScratchpad: string | undefined;
  let previousHome: string | undefined;
  let queuedMessages: QueuedMessage[];
  let releaseAgents: (() => void) | null;
  let cleanupCalls: number;

  function installSpawner(spawner: SubagentSpawner) {
    __setWorkflowSpawnerFactoryForTests(async () => ({
      spawner,
      cleanup: async () => {
        cleanupCalls += 1;
      },
    }));
  }

  /** Agents that finish only once the test calls releaseAgents(). */
  function gatedSpawner(): SubagentSpawner {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseAgents = release;
    return async (request, signal) => {
      await Promise.race([
        gate,
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      ]);
      if (signal.aborted) {
        return { value: null, failed: true, error: "aborted" };
      }
      return {
        value: `echo:${request.prompt}`,
        failed: false,
        durationMs: 1500,
        totalTokens: 12_000,
        costUsd: 0.01,
      };
    };
  }

  beforeEach(() => {
    previousScratchpad = process.env.LETTA_SCRATCHPAD;
    previousHome = process.env.HOME;
    scratchpad = mkdtempSync(join(tmpdir(), "workflow-tool-test-"));
    process.env.LETTA_SCRATCHPAD = scratchpad;
    // Executions journal under ~/.letta; keep the test's out of the real home.
    process.env.HOME = scratchpad;
    queuedMessages = [];
    releaseAgents = null;
    cleanupCalls = 0;
    clearPendingMessages();
    setMessageQueueAdder((message) => queuedMessages.push(message));
  });

  afterEach(() => {
    releaseAgents?.();
    for (const processState of backgroundProcesses.values()) {
      processState.completionNotificationSuppressed = true;
      try {
        processState.process.kill("SIGKILL");
      } catch {
        // Already finished.
      }
    }
    backgroundProcesses.clear();
    __resetWorkflowExecutionsForTests();
    __setWorkflowSpawnerFactoryForTests(null);
    setMessageQueueAdder(null);
    clearPendingMessages();
    if (previousScratchpad === undefined) {
      delete process.env.LETTA_SCRATCHPAD;
    } else {
      process.env.LETTA_SCRATCHPAD = previousScratchpad;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(scratchpad, { recursive: true, force: true });
  });

  test("rejects an invalid script before launching anything", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({ script: "return 1" });
    expect(result.status).toBe("error");
    expect(result.toolReturn).toContain("export const meta");
    expect(backgroundProcesses.size).toBe(0);
  });

  test("returns immediately with a task id and streams progress into the registry", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({ script: SCRIPT });
    expect(result.status).toBe("success");
    const taskId = /Task ID: (workflow_\d+)/.exec(result.toolReturn)?.[1];
    expect(taskId).toBeDefined();
    expect(result.toolReturn).toContain("Execution ID: wf-");
    expect(result.toolReturn).toContain("Script file:");
    expect(result.toolReturn).toContain("/workflows");

    const processState = backgroundProcesses.get(taskId as string);
    expect(processState?.kind).toBe("workflow");
    expect(processState?.status).toBe("running");
    expect(processState?.description).toBe(
      "Quick demo workflow with parallel agents",
    );

    await waitFor(
      () => (getWorkflowExecution(taskId as string)?.agentsRunning ?? 0) >= 1,
    );
    const live = getWorkflowExecution(taskId as string);
    expect(live?.status).toBe("running");
    expect(live?.agentsTotal).toBe(2);
    expect(live?.agentsDone).toBe(0);
    expect(live?.logs).toEqual(["starting"]);
    expect(live?.phases[0]?.title).toBe("Find");

    // The progress log is what TaskOutput reads while the run is live.
    const running = await task_output({
      task_id: taskId as string,
      block: false,
      timeout: 100,
    });
    expect(running.status).toBe("running");
    expect(queuedMessages).toHaveLength(0);

    releaseAgents?.();
    await waitFor(() => queuedMessages.length === 1);

    const finished = getWorkflowExecution(taskId as string);
    expect(finished?.status).toBe("completed");
    expect(finished?.agentsDone).toBe(2);
    expect(finished?.totalTokens).toBe(24_000);
    expect(processState?.status).toBe("completed");
    expect(processState?.exitCode).toBe(0);
    expect(cleanupCalls).toBe(1);

    const notification = queuedMessages[0];
    expect(notification?.kind).toBe("task_notification");
    expect(notification?.text).toContain(`<task-id>${taskId}</task-id>`);
    expect(notification?.text).toContain("<status>completed</status>");
    expect(notification?.text).toContain(
      'Workflow "Quick demo workflow with parallel agents" completed · ',
    );
    expect(notification?.text).toContain("2 agents · 24k tokens");
    expect(notification?.text).toContain('"count": 2');
    expect(notification?.text).toContain("total_tokens: 24000");
    expect(notification?.text).toContain("resumeFromExecutionId");

    const log = readFileSync(processState?.outputFile as string, "utf8");
    expect(log).toContain("── Find ──");
    expect(log).toContain("» starting");
    expect(log).toContain("✓ a");
    expect(log).toContain("[result]");
  });

  test("TaskStop aborts the run without waking the agent", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({ script: SCRIPT });
    const taskId = /Task ID: (workflow_\d+)/.exec(result.toolReturn)?.[1];
    await waitFor(
      () => (getWorkflowExecution(taskId as string)?.agentsRunning ?? 0) >= 1,
    );

    const stopped = await task_stop({ task_id: taskId as string });
    expect(stopped.killed).toBe(true);
    await waitFor(
      () => getWorkflowExecution(taskId as string)?.status === "failed",
    );
    await waitFor(() => cleanupCalls === 1);

    const processState = backgroundProcesses.get(taskId as string);
    expect(processState?.status).toBe("failed");
    expect(queuedMessages).toHaveLength(0);
    const snapshot = getWorkflowExecution(taskId as string);
    expect(snapshot?.agentsFailed).toBe(2);
  });

  test("a failing script notifies with failed status", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({
      script: `export const meta = { name: 'boom', description: 'explodes' }
throw new Error('kaboom')`,
    });
    expect(result.status).toBe("success");
    await waitFor(() => queuedMessages.length === 1);
    expect(queuedMessages[0]?.text).toContain("<status>failed</status>");
    expect(queuedMessages[0]?.text).toContain('Workflow "explodes" failed');
    expect(queuedMessages[0]?.text).toContain("kaboom");
  });
});

describe("Workflow tool completion payload", () => {
  test("survives script return values JSON cannot encode", async () => {
    const queued: QueuedMessage[] = [];
    setMessageQueueAdder((message) => queued.push(message));
    const scratch = mkdtempSync(join(tmpdir(), "workflow-bigint-"));
    const previousHome = process.env.HOME;
    const previousScratchpad = process.env.LETTA_SCRATCHPAD;
    process.env.HOME = scratch;
    process.env.LETTA_SCRATCHPAD = scratch;
    __setWorkflowSpawnerFactoryForTests(async () => ({
      spawner: async () => ({ value: "x", failed: false }),
      cleanup: async () => {},
    }));
    try {
      const result = await workflow({
        script: `export const meta = { name: 'big', description: 'returns a bigint' }
const self = { n: 10n }
self.me = self
return self`,
      });
      expect(result.status).toBe("success");
      await waitFor(() => queued.length === 1);
      expect(queued[0]?.text).toContain("<status>completed</status>");
      expect(queued[0]?.text).toContain("[object Object]");
    } finally {
      backgroundProcesses.clear();
      __resetWorkflowExecutionsForTests();
      __setWorkflowSpawnerFactoryForTests(null);
      setMessageQueueAdder(null);
      clearPendingMessages();
      process.env.HOME = previousHome;
      if (previousScratchpad === undefined) {
        delete process.env.LETTA_SCRATCHPAD;
      } else {
        process.env.LETTA_SCRATCHPAD = previousScratchpad;
      }
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("normalizeWorkflowArgs", () => {
  test("decodes JSON-encoded objects and arrays, leaves other values alone", async () => {
    const { normalizeWorkflowArgs } = await import("./workflow");
    expect(normalizeWorkflowArgs('{"files":["a","b"]}')).toEqual({
      files: ["a", "b"],
    });
    expect(normalizeWorkflowArgs(" [1, 2] ")).toEqual([1, 2]);
    expect(normalizeWorkflowArgs("plain text")).toBe("plain text");
    expect(normalizeWorkflowArgs("{not json")).toBe("{not json");
    expect(normalizeWorkflowArgs({ files: [] })).toEqual({ files: [] });
    expect(normalizeWorkflowArgs(undefined)).toBeUndefined();
  });
});
