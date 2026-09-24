import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBackend } from "@/backend";
import { runWithRuntimeContext } from "@/runtime-context";
import { clearCapturedToolExecutionContexts } from "@/tools/manager";
import { prepareToolExecutionContextForResolvedTarget } from "@/tools/toolset";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";
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
import { task_stop } from "./task-stop";
import {
  __setWorkflowSpawnerFactoryForTests,
  createSdkSpawnerHandle,
  normalizeWorkflowArgs,
  workflow,
} from "./workflow";

/** Progress lines written to a workflow's output file so far. */
function progressLineCount(outputFile: string | undefined): number {
  if (!outputFile) return 0;
  return readFileSync(outputFile, "utf8").split("\n").filter(Boolean).length;
}

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
  test("is exposed wherever Monitor is", () => {
    for (const preset of Object.values(TOOLSET_CATALOG)) {
      expect(preset.tools.includes("Workflow")).toBe(
        preset.tools.includes("Monitor"),
      );
    }
  });

  test("explicit allowlists can exclude it", async () => {
    try {
      const normal = await prepareToolExecutionContextForResolvedTarget({
        toolsetPreference: "letta",
      });
      expect(
        normal.preparedToolContext.clientTools.some(
          (tool) => tool.name === "Workflow",
        ),
      ).toBe(true);
      const restricted = await prepareToolExecutionContextForResolvedTarget({
        toolsetPreference: "letta",
        clientToolAllowlist: ["Read"],
      });
      expect(restricted.preparedToolContext.loadedToolNames).toEqual(["Read"]);
    } finally {
      clearCapturedToolExecutionContexts();
    }
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
        durationMs: 5,
        totalTokens: 12_000,
      };
    };
  }

  function taskIdOf(toolReturn: string): string {
    return /Task ID: (workflow_\d+)/.exec(toolReturn)?.[1] as string;
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

  test.each([null, "agent-ambient"])(
    "resolves the captured parent and conversation model with ambient agent %s",
    async (agentId) => {
      const backend = getBackend();
      const retrieveAgent = spyOn(backend, "retrieveAgent").mockResolvedValue({
        id: "agent-parent",
        model: "anthropic/claude-sonnet-4-6",
      } as Awaited<ReturnType<typeof backend.retrieveAgent>>);
      const retrieveConversation = spyOn(
        backend,
        "retrieveConversation",
      ).mockResolvedValue({
        id: "conv-child",
        model: "openai/gpt-4.1-mini",
      } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
      try {
        await runWithRuntimeContext(
          { agentId, conversationId: "conv-ambient" },
          async () => {
            // Construction is lazy: the real SDK client starts no query.
            const handle = await createSdkSpawnerHandle({
              parentScope: {
                agentId: "agent-parent",
                conversationId: "conv-child",
              },
            });
            try {
              expect(retrieveAgent).toHaveBeenCalledWith("agent-parent");
              expect(retrieveConversation).toHaveBeenCalledWith("conv-child");
            } finally {
              await handle.cleanup();
            }
          },
        );
      } finally {
        retrieveConversation.mockRestore();
        retrieveAgent.mockRestore();
      }
    },
  );

  test("rejects an unknown default model before creating a client", async () => {
    await expect(
      createSdkSpawnerHandle({
        model: "no-such-model",
        parentScope: { agentId: "agent-parent", conversationId: "default" },
      }),
    ).rejects.toThrow(/letta model list/);
  });

  test("reads relative script paths from the conversation directory", async () => {
    writeFileSync(join(scratchpad, "review.js"), SCRIPT);
    installSpawner(gatedSpawner());
    const result = await runWithRuntimeContext(
      { workingDirectory: scratchpad },
      () =>
        workflow({
          scriptPath: "review.js",
          parentScope: {
            agentId: "agent-parent",
            conversationId: "conv-parent",
          },
        }),
    );
    expect(result.status).toBe("success");
    releaseAgents?.();
    await waitFor(() => cleanupCalls === 1);
    expect(queuedMessages[0]?.text).toContain('"count": 2');
  });

  test("retains launch-time acting user through delayed completion", async () => {
    installSpawner(gatedSpawner());
    const result = await runWithRuntimeContext(
      { actingUserId: "cloud-user-a" },
      () =>
        workflow({
          script: SCRIPT,
          parentScope: {
            agentId: "agent-parent",
            conversationId: "conv-parent",
          },
        }),
    );
    const taskId = taskIdOf(result.toolReturn);
    expect(backgroundProcesses.get(taskId)?.runtimeScope).toMatchObject({
      actingUserId: "cloud-user-a",
    });
    runWithRuntimeContext({ actingUserId: "cloud-user-b" }, () =>
      releaseAgents?.(),
    );
    await waitFor(() => cleanupCalls === 1);
    expect(queuedMessages).toHaveLength(1);
    expect(queuedMessages[0]).toMatchObject({
      actingUserId: "cloud-user-a",
      agentId: "agent-parent",
      conversationId: "conv-parent",
    });
  });

  test("rejects an invalid script or concurrency before launching anything", async () => {
    let factories = 0;
    __setWorkflowSpawnerFactoryForTests(async () => {
      factories++;
      return { spawner: gatedSpawner(), cleanup: async () => {} };
    });
    const invalid = await workflow({ script: "return 1" });
    expect(invalid.status).toBe("error");
    expect(invalid.toolReturn).toContain("export const meta");
    for (const maxConcurrent of [0, 1.5]) {
      expect((await workflow({ script: SCRIPT, maxConcurrent })).status).toBe(
        "error",
      );
    }
    expect((await workflow({})).status).toBe("error");
    expect(factories).toBe(0);
    expect(backgroundProcesses.size).toBe(0);
  });

  test("returns immediately with a task id, streams progress, then notifies", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({ script: SCRIPT });
    expect(result.status).toBe("success");
    const taskId = taskIdOf(result.toolReturn);
    expect(result.toolReturn).toContain("Script file:");
    expect(result.toolReturn).toContain("journal.jsonl");
    expect(result.toolReturn).toContain("Output file:");

    const processState = backgroundProcesses.get(taskId);
    expect(processState?.kind).toBe("workflow");
    expect(processState?.status).toBe("running");
    expect(processState?.description).toBe(
      "Quick demo workflow with parallel agents",
    );

    // The progress log is what Read inspects while the run is live.
    await waitFor(() => progressLineCount(processState?.outputFile) >= 3);
    const live = getWorkflowExecution(taskId);
    expect(live).toMatchObject({
      status: "running",
      agentsTotal: 2,
      agentsRunning: 2,
      agentsDone: 0,
      logs: ["starting"],
    });
    expect(live?.phases[0]?.title).toBe("Find");
    expect(readFileSync(processState?.outputFile as string, "utf8")).toContain(
      "starting",
    );
    expect(queuedMessages).toHaveLength(0);

    releaseAgents?.();
    await waitFor(() => queuedMessages.length === 1);
    await waitFor(() => cleanupCalls === 1);
    expect(processState?.status).toBe("completed");
    expect(processState?.exitCode).toBe(0);

    const notification = queuedMessages[0];
    expect(notification?.kind).toBe("task_notification");
    expect(notification?.text).toContain(`<task-id>${taskId}</task-id>`);
    expect(notification?.text).toContain("<status>completed</status>");
    expect(notification?.text).toContain(
      'Workflow "Quick demo workflow with parallel agents" completed · ',
    );
    expect(notification?.text).toContain("2 agents · 24k tokens");
    expect(notification?.text).toContain("total_tokens: 24000");
    expect(notification?.text).toContain('"count": 2');
    expect(getWorkflowExecution(taskId)).toMatchObject({
      status: "completed",
      agentsDone: 2,
      totalTokens: 24_000,
    });

    const log = readFileSync(processState?.outputFile as string, "utf8");
    expect(log).toContain("── Find ──");
    expect(log).toContain("» starting");
    expect(log).toContain("✓ a");
    expect(log).toContain("[result]");

    const scriptPath = /Script file: (.+)/.exec(
      result.toolReturn,
    )?.[1] as string;
    expect(readFileSync(scriptPath, "utf8")).toBe(SCRIPT);
    const journal = readFileSync(
      join(scriptPath, "..", "journal.jsonl"),
      "utf8",
    );
    expect(journal.trim().split("\n")).toHaveLength(2);
  });

  test("usage updates live status without duplicating agent start lines", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installSpawner(async (request, _signal, hooks) => {
      hooks?.onUsage?.(500);
      hooks?.onUsage?.(1_200);
      await gate;
      return {
        value: request.prompt,
        failed: false,
        totalTokens: 1_200,
      };
    });
    const launched = await workflow({ script: SCRIPT });
    const taskId = taskIdOf(launched.toolReturn);
    const processState = backgroundProcesses.get(taskId);
    try {
      await waitFor(() => getWorkflowExecution(taskId)?.totalTokens === 2_400);
      expect(getWorkflowExecution(taskId)).toMatchObject({
        status: "running",
        agentsRunning: 2,
        totalTokens: 2_400,
      });
      expect(
        readFileSync(processState?.outputFile as string, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("▶ ")),
      ).toEqual(["▶ a", "▶ b"]);
    } finally {
      release();
    }
    await waitFor(() => cleanupCalls === 1);
    expect(processState?.status).toBe("completed");
    expect(
      readFileSync(processState?.outputFile as string, "utf8")
        .split("\n")
        .filter((line) => line.startsWith("✓ ")),
    ).toEqual(["✓ a", "✓ b"]);
    expect(getWorkflowExecution(taskId)).toMatchObject({
      status: "completed",
      agentsDone: 2,
      totalTokens: 2_400,
    });
  });

  test("TaskStop aborts the run without waking the agent", async () => {
    installSpawner(gatedSpawner());
    const result = await workflow({ script: SCRIPT });
    const taskId = taskIdOf(result.toolReturn);
    const processState = backgroundProcesses.get(taskId);
    await waitFor(() => progressLineCount(processState?.outputFile) >= 3);

    const stopped = await task_stop({ task_id: taskId });
    expect(stopped.killed).toBe(true);
    await waitFor(() => cleanupCalls === 1);
    expect(processState?.status).toBe("failed");
    expect(queuedMessages).toHaveLength(0);
    expect(readFileSync(processState?.outputFile as string, "utf8")).toContain(
      "[error] Workflow stopped",
    );
    expect(getWorkflowExecution(taskId)).toMatchObject({
      status: "failed",
      agentsFailed: 2,
    });
  });

  test("persists the full final result while bounding the completion notification", async () => {
    installSpawner(gatedSpawner());
    const value = `${"x".repeat(40000)}END-OF-RESULT`;
    const launched = await workflow({
      script: `export const meta = {name: 'large-result', description: 'large result'}\nreturn args`,
      args: value,
    });
    const taskId = taskIdOf(launched.toolReturn);
    await waitFor(() => cleanupCalls === 1);
    const outputFile = backgroundProcesses.get(taskId)?.outputFile as string;
    expect(readFileSync(outputFile, "utf8")).toContain(value);
    expect(queuedMessages[0]?.text).toContain("Workflow result truncated");
    expect(queuedMessages[0]?.text).not.toContain("END-OF-RESULT");
    expect(queuedMessages[0]?.text.length).toBeLessThan(32000);
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
    expect(queuedMessages[0]?.text).toMatch(
      /Workflow "explodes" failed after \d+s/,
    );
    expect(queuedMessages[0]?.text).toContain("kaboom");
  });

  test("survives script return values JSON cannot encode", async () => {
    installSpawner(async () => ({ value: "x", failed: false }));
    const result = await workflow({
      script: `export const meta = { name: 'big', description: 'returns a bigint' }
const self = { n: 10n }
self.me = self
return self`,
    });
    expect(result.status).toBe("success");
    await waitFor(() => queuedMessages.length === 1);
    expect(queuedMessages[0]?.text).toContain("<status>completed</status>");
    expect(queuedMessages[0]?.text).toContain("[object Object]");
  });
});

describe("normalizeWorkflowArgs", () => {
  test("decodes JSON-encoded objects and arrays, leaves other values alone", () => {
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
