import { afterEach, expect, test } from "bun:test";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";

const socket: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};
afterEach(() => setActiveRuntime(null));

test("a confirmed harness stop waits for both backend cancellation and the turn owner", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-child",
    "conv-child",
  );
  const controller = new AbortController();
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp",
    abortController: controller,
  });
  runtime.turnLifecycle.setRunId(lease, "run-child");
  let finishBackend!: () => void;
  const backend = new Promise<void>((resolve) => {
    finishBackend = resolve;
  });
  let acknowledged = false;
  const stopping = handleAbortMessageInput(
    listener,
    {
      command: {
        type: "abort_message",
        request_id: "stop",
        runtime: { agent_id: "agent-child", conversation_id: "conv-child" },
      },
      confirmBackendCancellation: true,
      socket,
      opts: {},
      processQueuedTurn: async () => {},
    },
    {
      cancelRun: async () => backend,
      emitRuntimeStateUpdates: () => {},
      emitInterruptedStatusDelta: () => {},
      scheduleQueuePump: () => {},
    },
  ).then((result) => {
    acknowledged = true;
    return result;
  });
  expect(controller.signal.aborted).toBe(true);
  expect(acknowledged).toBe(false);
  finishBackend();
  await Bun.sleep(0);
  expect(acknowledged).toBe(false);
  runtime.turnLifecycle.finish(lease, "cancelled");
  expect(await stopping).toBe(true);
});

test("an unconfirmed backend cancellation rejects the harness stop", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-child",
    "conv-child",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: "/tmp",
  });
  runtime.turnLifecycle.setRunId(lease, "run-child");
  await expect(
    handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          request_id: "stop",
          runtime: { agent_id: "agent-child", conversation_id: "conv-child" },
        },
        confirmBackendCancellation: true,
        socket,
        opts: {},
        processQueuedTurn: async () => {},
      },
      {
        cancelRun: async () => {
          throw new Error("Run cancellation failed");
        },
        cancelConversation: async () => {
          throw new Error("Conversation cancellation failed");
        },
        emitRuntimeStateUpdates: () => {},
        emitInterruptedStatusDelta: () => {},
        scheduleQueuePump: () => {},
      },
    ),
  ).rejects.toThrow("Conversation cancellation failed");
});
