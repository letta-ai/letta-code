import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { task_stop } from "@/tools/impl/task-stop";
import {
  clearExternalTools,
  executeExternalTool,
  getExternalToolDefinition,
} from "@/tools/manager";
import { autoBackgroundRemoteExternalTool } from "@/tools/remote-external-tool-background";
import type {
  ExternalToolCallCancelMessage,
  ExternalToolCallRequestMessage,
} from "@/types/external-tool-protocol";
import {
  isRuntimeExternalToolsUpdateCommand,
  isRuntimeStartExternalToolsGroup,
} from "@/websocket/listener/external-tool-protocol";
import {
  handleExternalToolCallResponseCommand,
  installExternalToolBridge,
  registerRuntimeExternalTools,
  rejectPendingExternalToolCalls,
} from "@/websocket/listener/external-tools";
import type { ListenerRuntime } from "@/websocket/listener/types";

type Frame = ExternalToolCallRequestMessage | ExternalToolCallCancelMessage;
const scope = { agentId: "agent-1", conversationId: "conv-1" };
const runtimes: ListenerRuntime[] = [];
afterEach(() => {
  for (const runtime of runtimes.splice(0))
    rejectPendingExternalToolCalls(runtime, "test cleanup");
  clearExternalTools();
  for (const [id, entry] of backgroundProcesses) {
    clearBackgroundProcessCleanup(id);
    if (entry.outputFile) rmSync(entry.outputFile, { force: true });
    backgroundProcesses.delete(id);
  }
});

function setup(
  capable: boolean,
  answer: "cancelled" | "result" | "silent" = "cancelled",
) {
  const frames: Frame[] = [];
  const runtime = {
    intentionallyClosed: false,
    pendingExternalToolCalls: new Map(),
    connections: new Map(),
  } as unknown as ListenerRuntime;
  runtimes.push(runtime);
  const respond = (requestId: string, cancelled: boolean) =>
    handleExternalToolCallResponseCommand(runtime, "controller", {
      type: "external_tool_call_response",
      request_id: requestId,
      ...(cancelled
        ? { error: "cancelled" }
        : { result: { content: [{ type: "text", text: "receipt-123" }] } }),
    });
  runtime.connections.set("controller", {
    id: "controller",
    writer: {
      kind: "local",
      isOpen: () => true,
      send(data: string) {
        const frame = JSON.parse(data) as Frame;
        frames.push(frame);
        if (frame.type === "external_tool_call_cancel" && answer !== "silent")
          queueMicrotask(() =>
            respond(frame.request_id, answer === "cancelled"),
          );
      },
    },
  } as never);
  registerRuntimeExternalTools(
    runtime,
    "controller",
    { agent_id: scope.agentId, conversation_id: scope.conversationId },
    [
      {
        tools: [{ name: "write", description: "Write", parameters: {} }],
        capabilities: { external_tool_call_cancel: capable },
      },
    ],
  );
  installExternalToolBridge(runtime, { cancelTimeoutMs: 20 });
  const tool = getExternalToolDefinition(
    JSON.stringify([
      "runtime",
      "controller",
      scope.agentId,
      scope.conversationId,
      "write",
    ]),
  );
  if (!tool) throw new Error("Missing registration");
  const notifications: unknown[] = [];
  let executionsSettled = 0;
  const start = (signal?: AbortSignal, yieldMs = 1) =>
    autoBackgroundRemoteExternalTool(
      "write",
      tool,
      (signal) =>
        executeExternalTool(
          "call",
          "write",
          {},
          undefined,
          tool,
          signal,
        ).finally(() => {
          executionsSettled++;
        }),
      {
        signal,
        yieldMs,
        runtimeScope: scope,
        enqueue: (message) => notifications.push(message),
      },
    );
  return {
    runtime,
    frames,
    respond,
    start,
    notifications,
    tool,
    get executionsSettled() {
      return executionsSettled;
    },
  };
}

for (const answer of ["cancelled", "result", "silent"] as const) {
  test(`TaskStop waits for controller ${answer}`, async () => {
    const f = setup(true, answer);
    const receipt = await f.start();
    const id = String(receipt.toolReturn).match(/task ID: (\S+)/)?.[1];
    expect(id).toBeDefined();
    const result = await task_stop({ task_id: id as string });
    expect(f.frames.map((frame) => frame.type)).toEqual([
      "external_tool_call_request",
      "external_tool_call_cancel",
    ]);
    expect(f.frames[1]?.request_id).toBe(f.frames[0]?.request_id);
    expect(f.runtime.pendingExternalToolCalls.size).toBe(0);
    expect(result.killed).toBe(answer === "cancelled");
    expect(result.output).toContain(
      answer === "cancelled"
        ? "Stopped"
        : answer === "result"
          ? "Already finished: receipt-123"
          : "not confirmed",
    );
    await Bun.sleep(0);
    expect(f.notifications).toHaveLength(1);
  });
}

test("legacy controller keeps notification and receives no cancel", async () => {
  const f = setup(false);
  const receipt = await f.start();
  const id = String(receipt.toolReturn).match(/task ID: (\S+)/)?.[1];
  const result = await task_stop({ task_id: id as string });
  expect(result.killed).toBe(false);
  expect(result.output).toContain("doesn't support cancelling");
  expect(f.frames).toHaveLength(1);
  f.respond(f.frames[0]?.request_id as string, false);
  await Bun.sleep(0);
  expect(f.notifications).toHaveLength(1);
});

test("turn abort sends cancel to capable controller", async () => {
  const f = setup(true);
  const turn = new AbortController();
  const running = f.start(turn.signal);
  turn.abort();
  await running;
  await Bun.sleep(0);
  expect(f.frames[1]?.type).toBe("external_tool_call_cancel");
  expect(f.runtime.pendingExternalToolCalls.size).toBe(0);
});

test("foreground interrupt releases a silent controller's pending cancellation", async () => {
  const f = setup(true, "silent");
  const turn = new AbortController();
  const running = f.start(turn.signal, 10_000);
  const pending = [...f.runtime.pendingExternalToolCalls.values()][0];
  expect(pending).toBeDefined();
  turn.abort();
  const cancelTimer = pending?.timeout;
  const result = await running;
  expect(result.status).toBe("error");
  expect(result.toolReturn).toContain("interrupted by user");
  expect(f.frames[1]?.type).toBe("external_tool_call_cancel");
  expect(f.runtime.pendingExternalToolCalls.size).toBe(0);
  expect(cancelTimer?.hasRef()).toBe(false);
  expect(f.executionsSettled).toBe(1);
  expect(backgroundProcesses.size).toBe(0);
  f.respond(f.frames[0]?.request_id as string, false);
  await Bun.sleep(30);
  expect(f.notifications).toHaveLength(0);
});

test("turn abort after backgrounding still waits for controller confirmation", async () => {
  const f = setup(true, "silent");
  const turn = new AbortController();
  await f.start(turn.signal);
  turn.abort();
  expect(f.runtime.pendingExternalToolCalls.size).toBe(1);
  f.respond(f.frames[0]?.request_id as string, true);
  await Bun.sleep(0);
  expect(f.runtime.pendingExternalToolCalls.size).toBe(0);
  expect(f.notifications).toHaveLength(1);
});

test("completed call does not send cancel on later abort", async () => {
  const f = setup(true);
  const turn = new AbortController();
  const running = f.start(turn.signal);
  f.respond(f.frames[0]?.request_id as string, false);
  expect((await running).toolReturn).toBe("receipt-123");
  turn.abort();
  expect(f.frames).toHaveLength(1);
});

test("registration and update validate cancellation capability", () => {
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [],
      capabilities: { external_tool_call_cancel: true },
    }),
  ).toBe(true);
  expect(
    isRuntimeStartExternalToolsGroup({
      tools: [],
      capabilities: { external_tool_call_cancel: "yes" },
    }),
  ).toBe(false);
  expect(
    isRuntimeExternalToolsUpdateCommand({
      type: "runtime_external_tools_update",
      request_id: "update",
      updates: [
        {
          runtimes: [{ agent_id: "a", conversation_id: "c" }],
          external_tools: [
            { tools: [], capabilities: { external_tool_call_cancel: true } },
          ],
        },
      ],
    }),
  ).toBe(true);
});
