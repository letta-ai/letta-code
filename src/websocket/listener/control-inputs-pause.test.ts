/**
 * abort_message parks the user's queued messages (Codex-style "queue paused
 * because you interrupted"). System items still drain once the interrupted
 * lease settles; parked items wait for resume_queue or the next user message.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { scheduleQueuePump } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for listener queue state");
}

function enqueueUser(runtime: ConversationRuntime, text: string): void {
  expect(
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: text }],
    }),
  ).toBe(true);
}

function enqueueNotification(runtime: ConversationRuntime, text: string): void {
  runtime.queueRuntime.enqueue({
    kind: "task_notification",
    source: "task_notification",
    text,
    agentId: "agent-1",
    conversationId: "conv-1",
  } as Parameters<typeof runtime.queueRuntime.enqueue>[0]);
}

/**
 * Start an active turn, queue `queuedBeforeAbort`, abort it, and settle the
 * cancellation. Returns the processed turns and the runtime.
 */
async function interruptWithQueuedItems(params: {
  queuedBeforeAbort: (runtime: ConversationRuntime) => void;
  queuedAfterAbort?: (runtime: ConversationRuntime) => void;
}) {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const socket = createOpenTransport();
  const options = {} as StartListenerOptions;
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.turnLifecycle.setRunId(lease, "run-1");
  const processedTurns: IncomingMessage[] = [];
  const processQueuedTurn = mock(async (incoming: IncomingMessage) => {
    processedTurns.push(incoming);
  });
  setActiveRuntime(listener);
  params.queuedBeforeAbort(runtime);

  expect(
    await handleAbortMessageInput(
      listener,
      {
        command: {
          type: "abort_message",
          runtime: { agent_id: "agent-1", conversation_id: "conv-1" },
          run_id: "run-1",
        },
        socket,
        opts: options,
        processQueuedTurn,
      },
      {
        cancelRun: async () => {},
        cancelConversation: async () => {},
      },
    ),
  ).toBe(true);
  params.queuedAfterAbort?.(runtime);

  expect(
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket,
      runId: "run-1",
      agentId: "agent-1",
      conversationId: "conv-1",
    }).finished,
  ).toBe(true);
  await waitFor(
    () =>
      runtime.turnLifecycle.kind === "idle" &&
      !runtime.queuePumpActive &&
      !runtime.queuePumpScheduled,
  );
  return { runtime, socket, options, processQueuedTurn, processedTurns };
}

describe("abort_message parks queued user messages", () => {
  afterEach(() => setActiveRuntime(null));

  test("parked user messages wait while a notification queued during the interrupt drains", async () => {
    const { runtime, processedTurns } = await interruptWithQueuedItems({
      queuedBeforeAbort: (r) => enqueueUser(r, "queued before esc"),
      queuedAfterAbort: (r) => enqueueNotification(r, "<monitor-done/>"),
    });

    expect(processedTurns).toHaveLength(1);
    const drained = JSON.stringify(processedTurns[0]?.messages);
    expect(drained).toContain("<monitor-done/>");
    expect(drained).not.toContain("queued before esc");
    // The parked message is still there, flagged paused, and nothing is pumping.
    expect(runtime.queueRuntime.length).toBe(1);
    expect(runtime.queueRuntime.pausedCount).toBe(1);
    expect(runtime.queueRuntime.items[0]?.paused).toBe(true);
    expect(runtime.turnLifecycle.kind).toBe("idle");
  });

  test("resume releases parked messages and the pump starts their turn", async () => {
    const { runtime, socket, options, processQueuedTurn, processedTurns } =
      await interruptWithQueuedItems({
        queuedBeforeAbort: (r) => enqueueUser(r, "queued before esc"),
      });
    expect(processedTurns).toHaveLength(0);

    expect(runtime.queueRuntime.resume()).toBe(1);
    scheduleQueuePump(runtime, socket, options, processQueuedTurn);
    await waitFor(() => processedTurns.length === 1);

    expect(JSON.stringify(processedTurns[0]?.messages)).toContain(
      "queued before esc",
    );
    expect(runtime.queueRuntime.length).toBe(0);
  });

  test("a new user message resumes the parked ones and runs after them", async () => {
    const { runtime, socket, options, processQueuedTurn, processedTurns } =
      await interruptWithQueuedItems({
        queuedBeforeAbort: (r) => enqueueUser(r, "queued before esc"),
      });

    enqueueUser(runtime, "typed after esc");
    expect(runtime.queueRuntime.pausedCount).toBe(0);
    scheduleQueuePump(runtime, socket, options, processQueuedTurn);
    await waitFor(() => runtime.queueRuntime.length === 0);

    const all = JSON.stringify(processedTurns.map((turn) => turn.messages));
    expect(all.indexOf("queued before esc")).toBeGreaterThan(-1);
    expect(all.indexOf("queued before esc")).toBeLessThan(
      all.indexOf("typed after esc"),
    );
  });
});
