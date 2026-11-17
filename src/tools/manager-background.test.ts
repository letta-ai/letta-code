import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { emptyEventEmissionResult, type ModEvents } from "@/mods/event-emitter";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";
import {
  executeTool,
  getExecutionContextById,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import {
  clearPendingMessages,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";

const contexts: string[] = [];
const existingEntries = new Set<string>();
beforeEach(() => {
  existingEntries.clear();
  for (const id of backgroundProcesses.keys()) existingEntries.add(id);
});
afterEach(() => {
  for (const id of contexts.splice(0)) releaseToolExecutionContext(id);
  setMessageQueueAdder(null);
  clearPendingMessages();
  for (const [id, entry] of backgroundProcesses) {
    if (existingEntries.has(id)) continue;
    clearBackgroundProcessCleanup(id);
    if (entry.outputFile) rmSync(entry.outputFile, { force: true });
    backgroundProcesses.delete(id);
  }
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function prepare(
  name: "TaskStop" | "Edit",
  fn: () => Promise<unknown>,
  events?: ModEvents,
) {
  const prepared = await prepareToolExecutionContextForSpecificTools([name], {
    runtimeContext: {
      agentId: "agent-budget",
      conversationId: "conv-budget",
      foregroundYieldMs: 1000,
    },
    modEvents: events,
  });
  contexts.push(prepared.contextId);
  const context = getExecutionContextById(prepared.contextId);
  const tool = context?.toolRegistry.get(name);
  if (!context || !tool) throw new Error("Missing test tool");
  context.toolRegistry.set(name, { ...tool, fn });
  return { toolContextId: prepared.contextId };
}

function backgroundEntry(receipt: { toolReturn: unknown }) {
  const id = String(receipt.toolReturn).match(/task ID: (\S+)/)?.[1];
  const entry = id ? backgroundProcesses.get(id) : undefined;
  if (!id || !entry) throw new Error("Missing returned background task");
  return [id, entry] as const;
}

describe("shared executor background boundary", () => {
  test("TaskStop uses the conversation budget and notifies with the real late result", async () => {
    const done = deferred<unknown>();
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const options = await prepare("TaskStop", () => done.promise);
    const result = await executeTool("TaskStop", {}, options);
    expect(result.status).toBe("success");
    expect(notifications).toHaveLength(0);
    done.resolve({ killed: true });
    for (let i = 0; i < 20 && !notifications.length; i++) await Bun.sleep(5);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      agentId: "agent-budget",
      conversationId: "conv-budget",
      kind: "task_notification",
    });
    expect(notifications[0]?.text).toContain("Process killed successfully");
  });

  test("a replaced listener guard drops the late client-tool notification", async () => {
    const done = deferred<unknown>();
    const barrier = deferred<boolean>();
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const options = await prepare("TaskStop", () => done.promise);
    const context = getExecutionContextById(options.toolContextId);
    if (!context) throw new Error("Missing context");
    let checked = false;
    context.shouldEnqueueBackground = () => {
      checked = true;
      return barrier.promise;
    };
    const receipt = await executeTool("TaskStop", {}, options);
    done.resolve({ killed: true });
    await Bun.sleep(10);
    expect(checked).toBe(true);
    expect(notifications).toHaveLength(0);
    barrier.resolve(false);
    await Bun.sleep(10);
    expect(backgroundEntry(receipt)[1].status).toBe("completed");
    expect(notifications).toHaveLength(0);
  });

  test("TaskStop aborts the signal delivered to a built-in by the manager", async () => {
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    let receivedSignal: AbortSignal | undefined;
    const options = await prepare("TaskStop", async () => ({}));
    const context = getExecutionContextById(options.toolContextId);
    const tool = context?.toolRegistry.get("TaskStop");
    if (!context || !tool) throw new Error("Missing tool");
    context.toolRegistry.set("TaskStop", {
      ...tool,
      fn: (args: Record<string, unknown>) =>
        new Promise((resolve) => {
          receivedSignal = args.signal as AbortSignal;
          receivedSignal.addEventListener("abort", () =>
            resolve({ killed: false }),
          );
        }),
    });
    const receipt = await executeTool("TaskStop", {}, options);
    const [id, entry] = backgroundEntry(receipt);
    expect(await task_stop({ task_id: id })).toEqual({
      killed: true,
      output: "Stopped",
    });
    expect(receivedSignal?.aborted).toBe(true);
    await Bun.sleep(10);
    expect(readFileSync(entry.outputFile as string, "utf8")).toContain(
      "Failed to kill process",
    );
    expect(notifications).toHaveLength(0);
  });

  test("a client-local MCP executor yields without listener opt-in", async () => {
    const done = deferred<{
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    }>();
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const options = await prepare("TaskStop", async () => ({}));
    const context = getExecutionContextById(options.toolContextId);
    if (!context) throw new Error("Missing context");
    context.externalTools.set("mcp__example__lookup", {
      name: "mcp__example__lookup",
      description: "Lookup",
      parameters: {},
      executor: () => done.promise,
    });
    const result = await executeTool("mcp__example__lookup", {}, options);
    expect(result.status).toBe("success");
    expect(notifications).toHaveLength(0);
    done.resolve({
      content: [{ type: "text", text: "lookup finished" }],
      isError: false,
    });
    for (let i = 0; i < 20 && !notifications.length; i++) await Bun.sleep(5);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.text).toContain("lookup finished");
  });

  test("waiting before permission/execution does not spend the tool budget", async () => {
    const approval = deferred<void>();
    const done = deferred<unknown>();
    let started = false;
    let returned = false;
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const options = await prepare(
      "TaskStop",
      () => {
        started = true;
        return done.promise;
      },
      {
        hasHandlers: () => false,
        emit: async (name) => {
          if (name === "tool_start") await approval.promise;
          return emptyEventEmissionResult(name);
        },
      },
    );
    const pending = executeTool("TaskStop", {}, options).then((result) => {
      returned = true;
      return result;
    });
    await Bun.sleep(1100);
    expect(started).toBe(false);
    expect(returned).toBe(false);
    approval.resolve();
    await Bun.sleep(100);
    expect(started).toBe(true);
    expect(returned).toBe(false);
    done.resolve({ killed: true });
    await pending;
    expect(notifications).toHaveLength(0);
  });

  test("Edit completes before the executor returns", async () => {
    const done = deferred<unknown>();
    let returned = false;
    const notifications: QueuedMessage[] = [];
    setMessageQueueAdder((message) => notifications.push(message));
    const options = await prepare("Edit", () => done.promise);
    const pending = executeTool("Edit", {}, options).then((result) => {
      returned = true;
      return result;
    });
    await Bun.sleep(1100);
    expect(returned).toBe(false);
    done.resolve({ success: true });
    await pending;
    expect(notifications).toHaveLength(0);
  });
});
