/**
 * abort_message response contract relied on by Cloud's selected-runtime abort
 * relay (letta-cloud #17885) and TaskStop's direct listener abort (#4853):
 * - a broad abort on an idle runtime fences the queue so no queued successor
 *   starts after the caller was told the conversation stopped;
 * - a second exact abort for a lease that is already cancelling joins it and
 *   reports settlement instead of "not active";
 * - an exact abort for a run whose lease already settled says so, even after
 *   the idle conversation runtime was evicted;
 * - an exact abort whose run cannot be cancelled fails closed and never widens
 *   to the whole conversation, whatever its queue intent;
 * - queue_paused reports whether queued input is actually parked.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import type { AbortMessageCommand } from "@/types/protocol_v2";
import { abortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { scheduleQueuePump } from "./queue";
import { evictConversationRuntimeIfIdle, setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type {
  IncomingMessage,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

const scope = { agent_id: "agent-1", conversation_id: "conv-1" };

function createOpenTransport(): ListenerTransport {
  return {
    kind: "local",
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  };
}

function abort(
  listener: ListenerRuntime,
  command: Omit<AbortMessageCommand, "type" | "runtime">,
  processQueuedTurn: (
    message: IncomingMessage,
  ) => Promise<void> = async () => {},
  cancelRun: (agentId: string, runId: string) => Promise<void> = async () => {},
  cancelConversation: () => Promise<void> = async () => {
    throw new Error("must not widen exact cancellation");
  },
  cancelConversationRun: (
    conversationId: string,
    runId?: string | null,
  ) => Promise<void> = async () => {},
) {
  return abortMessageInput(
    listener,
    {
      command: { type: "abort_message", runtime: scope, ...command },
      socket: createOpenTransport(),
      opts: {} as StartListenerOptions,
      processQueuedTurn,
    },
    {
      cancelRun,
      cancelConversation,
      cancelConversationRun,
      settlementTimeoutMs: 1_000,
    },
  );
}

function startTurn(listener: ListenerRuntime, runId: string) {
  const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  runtime.turnLifecycle.setRunId(lease, runId);
  return { runtime, lease };
}

describe("abort_message response contract", () => {
  afterEach(() => setActiveRuntime(null));

  test("a broad abort between queued turns fences the successor", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [{ role: "user", content: "queued successor" }],
      }),
    ).toBe(true);
    const processed: IncomingMessage[] = [];
    const processQueuedTurn = async (message: IncomingMessage) => {
      processed.push(message);
    };

    const result = await abort(
      listener,
      { wait_for_settlement: true, pause_queue: true },
      processQueuedTurn,
    );

    expect(result).toEqual({
      aborted: false,
      outcome: "queue_fenced",
      queuePaused: true,
      leaseSettled: false,
    });
    scheduleQueuePump(
      runtime,
      createOpenTransport(),
      {} as StartListenerOptions,
      processQueuedTurn,
    );
    await Bun.sleep(20);
    expect(processed).toEqual([]);
    expect(runtime.queueRuntime.pausedCount).toBe(1);
  });

  test("an idle abort that must not pause the queue is not applicable", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);

    expect(await abort(listener, { pause_queue: false })).toMatchObject({
      aborted: false,
      outcome: "not_applicable",
      queuePaused: false,
    });
  });

  test("a second exact abort joins the first and reports settlement", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime, lease } = startTurn(listener, "run-child");
    const cancelRun = mock(async () => {});

    // C1: Cloud relays TaskStop's exact cancel first.
    const relayed = abort(
      listener,
      { run_id: "run-child", wait_for_settlement: true, pause_queue: false },
      undefined,
      cancelRun,
    );
    await Bun.sleep(1);
    expect(runtime.turnLifecycle.kind).toBe("cancelling");
    expect(runtime.activeRunId).toBeNull();

    // C2: TaskStop's own direct listener abort for the same run.
    const direct = abort(listener, {
      run_id: "run-child",
      wait_for_settlement: true,
      pause_queue: false,
    });
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket: createOpenTransport(),
      runId: "run-child",
      agentId: "agent-1",
      conversationId: "conv-1",
    });

    expect(await relayed).toMatchObject({
      aborted: true,
      outcome: "interrupted",
      leaseSettled: true,
    });
    expect(await direct).toEqual({
      aborted: true,
      outcome: "joined",
      queuePaused: false,
      leaseSettled: true,
    });
    expect(cancelRun).toHaveBeenCalledTimes(1);
    expect(runtime.turnLifecycle.kind).toBe("idle");
  });

  test("an exact abort after its lease settled reports already_settled", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime, lease } = startTurn(listener, "run-done");
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket: createOpenTransport(),
      runId: "run-done",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);

    expect(
      await abort(listener, { run_id: "run-done", wait_for_settlement: true }),
    ).toEqual({
      aborted: true,
      outcome: "already_settled",
      queuePaused: false,
      leaseSettled: true,
    });
  });

  test("an exact abort never touches a replacement turn", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime } = startTurn(listener, "run-replacement");
    const cancelRun = mock(async () => {});

    expect(
      await abort(
        listener,
        { run_id: "run-unknown", wait_for_settlement: true },
        undefined,
        cancelRun,
      ),
    ).toMatchObject({ aborted: false, outcome: "not_applicable" });
    expect(runtime.turnLifecycle.kind).toBe("active");
    expect(cancelRun).not.toHaveBeenCalled();
  });

  test("an exact abort without pause_queue:false never widens on cancel failure", async () => {
    // cancelListenerInput and other existing callers send run_id without any
    // queue flag; a failed exact cancel must not become cancel-all.
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime, lease } = startTurn(listener, "run-exact");
    const widened = mock(async () => {});

    const pending = abort(
      listener,
      { run_id: "run-exact", wait_for_settlement: true },
      undefined,
      async () => {
        throw new Error("backend refused exact cancel");
      },
      widened,
    );
    await Bun.sleep(5);
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket: createOpenTransport(),
      runId: "run-exact",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    await pending;
    expect(widened).not.toHaveBeenCalled();
  });

  test("queue_paused reports the parked queue, not the request", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime, lease } = startTurn(listener, "run-a");
    expect(
      enqueueInboundUserMessage(runtime, {
        type: "message",
        agentId: "agent-1",
        conversationId: "conv-1",
        messages: [{ role: "user", content: "queued" }],
      }),
    ).toBe(true);

    // A pausing abort parks the queued item.
    const first = abort(listener, {
      run_id: "run-a",
      wait_for_settlement: true,
      pause_queue: true,
    });
    await Bun.sleep(1);
    // A non-pausing duplicate still sees the queue parked.
    const duplicate = abort(listener, {
      run_id: "run-a",
      wait_for_settlement: true,
      pause_queue: false,
    });
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket: createOpenTransport(),
      runId: "run-a",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    expect(await first).toMatchObject({
      outcome: "interrupted",
      queuePaused: true,
    });
    expect(await duplicate).toMatchObject({
      outcome: "joined",
      queuePaused: true,
    });
    expect(
      await abort(listener, { run_id: "run-a", wait_for_settlement: true }),
    ).toMatchObject({ outcome: "already_settled", queuePaused: true });

    runtime.queueRuntime.resume();
    expect(
      await abort(listener, { run_id: "run-a", wait_for_settlement: true }),
    ).toMatchObject({ outcome: "already_settled", queuePaused: false });
  });

  test("a broad idle abort with an empty queue fences nothing", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);

    expect(
      await abort(listener, { wait_for_settlement: true, pause_queue: true }),
    ).toEqual({
      aborted: false,
      outcome: "not_applicable",
      queuePaused: false,
      leaseSettled: false,
    });
  });

  test("not_applicable reports a queue that is still parked", async () => {
    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(listener, "agent-1", "conv-1");
    enqueueInboundUserMessage(runtime, {
      type: "message",
      agentId: "agent-1",
      conversationId: "conv-1",
      messages: [{ role: "user", content: "parked" }],
    });
    runtime.queueRuntime.pause();

    expect(
      await abort(listener, { run_id: "run-unknown", pause_queue: false }),
    ).toMatchObject({ outcome: "not_applicable", queuePaused: true });
    expect(await abort(listener, { pause_queue: false })).toMatchObject({
      outcome: "not_applicable",
      queuePaused: true,
    });
  });

  test("an exact pause_queue:false abort still retries that same run", async () => {
    // TaskStop's direct listener abort sends pause_queue:false. A failed
    // cancelRun must retry the exact run, not give up or widen.
    const listener = createRuntime();
    setActiveRuntime(listener);
    const { runtime, lease } = startTurn(listener, "run-exact-nopause");
    const widened = mock(async () => {});
    const exactRetry = mock(
      async (_conversationId: string, _runId?: string | null) => {},
    );

    const pending = abort(
      listener,
      {
        run_id: "run-exact-nopause",
        wait_for_settlement: true,
        pause_queue: false,
      },
      undefined,
      async () => {
        throw new Error("backend refused exact cancel");
      },
      widened,
      exactRetry,
    );
    await Bun.sleep(5);
    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket: createOpenTransport(),
      runId: "run-exact-nopause",
      agentId: "agent-1",
      conversationId: "conv-1",
    });
    await pending;
    expect(exactRetry).toHaveBeenCalledWith("conv-1", "run-exact-nopause");
    expect(widened).not.toHaveBeenCalled();
  });
});
