import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type { IncomingMessage, StartListenerOptions } from "./types";

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener interrupt state");
}

describe("listener interrupt queue handoff", () => {
  afterEach(() => setActiveRuntime(null));

  test("does not release the next turn before cancellation fallback settles", async () => {
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    const socket = createOpenTransport();
    const options = {} as StartListenerOptions;
    const oldLease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: process.cwd(),
    });
    runtime.turnLifecycle.setRunId(oldLease, "run-old");
    const cancellation = createDeferred();
    const cancelRun = mock(async (_agentId: string, _runId: string) => {
      throw new Error("run-scoped cancellation unavailable");
    });
    const cancelConversation = mock(
      async (_agentId: string, _conversationId: string) => cancellation.promise,
    );
    const processedTurns: IncomingMessage[] = [];
    const processQueuedTurn = mock(async (incoming: IncomingMessage) => {
      processedTurns.push(incoming);
    });
    setActiveRuntime(listener);

    expect(
      await handleAbortMessageInput(
        listener,
        {
          command: {
            type: "abort_message",
            runtime: {
              agent_id: "agent-1",
              conversation_id: "conv-1",
            },
            run_id: "run-old",
          },
          socket,
          opts: options,
          processQueuedTurn,
        },
        { cancelRun, cancelConversation },
      ),
    ).toBe(true);

    const queued = enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "kill the looping subagent" }],
    });
    expect(queued).toBe(true);
    scheduleQueuePump(runtime, socket, options, processQueuedTurn);

    expect(
      finishListenerTurn(runtime, oldLease, {
        stopReason: "cancelled",
        socket,
        runId: "run-old",
        agentId: "agent-1",
        conversationId: "conv-1",
      }).finished,
    ).toBe(true);

    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    );
    expect(runtime.turnLifecycle.kind).toBe("cancelling");
    expect(runtime.queueRuntime.length).toBe(1);
    expect(processedTurns).toEqual([]);
    expect(cancelRun).toHaveBeenCalledWith("agent-1", "run-old");
    expect(cancelConversation).toHaveBeenCalledWith("agent-1", "conv-1");

    cancellation.resolve();
    await waitFor(
      () =>
        runtime.turnLifecycle.kind === "idle" &&
        runtime.queueRuntime.length === 0 &&
        processedTurns.length === 1,
    );

    expect(processedTurns[0]?.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "kill the looping subagent" }],
      },
    ]);
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(cancelConversation).toHaveBeenCalledTimes(1);
    expect(processQueuedTurn).toHaveBeenCalledTimes(1);
  });
});
