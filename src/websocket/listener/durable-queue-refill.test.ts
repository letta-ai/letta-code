import { expect, mock, test } from "bun:test";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { openListenerConnection } from "./connection";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  commitInputDisposition,
  createAcceptedInputDispositionLedger,
  loadDurableQueuedInputEntries,
  ordinaryInputIdentity,
  reserveInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "./lifecycle";
import { consumeQueuedTurn } from "./queue";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { createTurnCorrelation } from "./turn-correlation";
import type { IncomingMessage, StartListenerOptions } from "./types";

function createDurableRuntime() {
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: null });
  return getOrCreateScopedRuntime(
    listener,
    "agent-durable",
    "conversation-durable",
  );
}

function durableIncoming(clientMessageId: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-durable",
    conversationId: "conversation-durable",
    messages: [
      { role: "user", content: "continue", client_message_id: clientMessageId },
    ],
  };
}

function approvalBarrier(text: string): Parameters<QueueRuntime["enqueue"]>[0] {
  return { kind: "approval_result", source: "system", text } as Parameters<
    QueueRuntime["enqueue"]
  >[0];
}

function admitQueuedInputs(
  runtime: ReturnType<typeof createDurableRuntime>,
  count: number,
  prefix: string,
): void {
  for (let index = 0; index < count; index += 1) {
    const id = `${prefix}-${index}`;
    const admission = reserveInputDisposition(
      runtime,
      ordinaryInputIdentity(id),
    );
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: durableIncoming(id),
      }),
    ).toBe(true);
  }
}

async function installLifecycleRefill(
  runtime: ReturnType<typeof createDurableRuntime>,
) {
  const transport = {
    kind: "local" as const,
    bufferedAmount: 0,
    isOpen: () => true,
    send: () => {},
  } satisfies ListenerTransport;
  const options: StartListenerOptions = {
    connectionId: "conn-refill",
    wsUrl: "local://refill-test",
    deviceId: "device-refill",
    connectionName: "refill-test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: runtime.listener,
    connectionId: options.connectionId,
    writer: transport,
    options,
  });
  setActiveRuntime(runtime.listener);
  const restore = mock(
    (...args: Parameters<typeof restoreDurableQueuedInputs>) =>
      restoreDurableQueuedInputs(...args),
  );
  await startConnectedListenerRuntime(
    runtime.listener,
    transport,
    options,
    async () => {},
    {
      startHeartbeat: false,
      startCronScheduler: false,
      startProcessServices: false,
      emitInitialState: false,
      recoverRecordedWork: async () => {},
      restoreDurableQueuedInputs: restore,
    },
  );
  runtime.listener.restoreDurableQueuedInputs?.();
  return restore;
}

test("lifecycle refill coalesces soft overflow and guards inactive runtimes", async () => {
  const runtime = createDurableRuntime();
  admitQueuedInputs(runtime, 105, "cm-soft");
  const restore = await installLifecycleRefill(runtime);
  try {
    expect(restore).toHaveBeenCalledTimes(1);
    expect(runtime.queueRuntime.length).toBe(100);

    const first = consumeQueuedTurn(runtime);
    expect(first?.queuedTurn.durableInputIdentities).toHaveLength(100);
    await Promise.resolve();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(runtime.queueRuntime.length).toBe(5);

    const replacement = createRuntime();
    setActiveRuntime(replacement);
    expect(runtime.listener.restoreDurableQueuedInputs?.()).toBe(0);
    expect(restore).toHaveBeenCalledTimes(2);

    setActiveRuntime(runtime.listener);
    runtime.listener.intentionallyClosed = true;
    expect(runtime.listener.restoreDurableQueuedInputs?.()).toBe(0);
    expect(restore).toHaveBeenCalledTimes(2);

    const second = consumeQueuedTurn(runtime);
    expect(second?.queuedTurn.durableInputIdentities).toHaveLength(5);
    expect(
      new Set([
        ...(first?.queuedTurn.durableInputIdentities ?? []),
        ...(second?.queuedTurn.durableInputIdentities ?? []),
      ]).size,
    ).toBe(105);
  } finally {
    stopRuntime(runtime.listener, true);
    setActiveRuntime(null);
  }
});

test("a started teleport payload is not restored during its dequeue handoff", () => {
  const runtime = createDurableRuntime();
  const identity = teleportInputIdentity("teleport-started");
  const incoming: IncomingMessage = {
    ...durableIncoming("cm-submit-teleport"),
    durableInputIdentities: [identity],
  };
  const admission = reserveInputDisposition(runtime, identity);
  if (admission.kind !== "reserved") throw new Error("expected reservation");
  expect(
    commitInputDisposition(runtime, admission.reservation, "queued", {
      incoming,
    }),
  ).toBe(true);
  expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(1);

  const dequeued = consumeQueuedTurn(runtime);
  expect(dequeued?.queuedTurn.durableInputIdentities).toEqual([identity]);
  if (!dequeued) throw new Error("expected dequeued turn");
  createTurnCorrelation(
    runtime,
    dequeued.queuedTurn,
    dequeued.dequeuedBatch.batchId,
  );
  expect(
    runtime.dequeuedInputIdentitiesByBatchId.get(
      dequeued.dequeuedBatch.batchId,
    ),
  ).toEqual([identity]);
  expect(runtime.queueRuntime.length).toBe(0);
  expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(0);
  expect(runtime.queueRuntime.length).toBe(0);
});

test("durable rehydration preserves paused work when admitted and ordinary ingress resumes", () => {
  const runtime = createDurableRuntime();
  expect(
    enqueueInboundUserMessage(runtime, durableIncoming("paused-existing")),
  ).toBe(true);
  expect(runtime.queueRuntime.pause()).toBe(1);
  admitQueuedInputs(runtime, 1, "rehydrated");

  expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(1);
  expect(runtime.queueRuntime.pausedCount).toBe(1);
  expect(runtime.queueRuntime.length).toBe(2);
  expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(0);
  expect(runtime.queueRuntime.pausedCount).toBe(1);
  expect(runtime.queueRuntime.length).toBe(2);

  expect(
    enqueueInboundUserMessage(runtime, durableIncoming("ordinary-new")),
  ).toBe(true);
  expect(runtime.queueRuntime.pausedCount).toBe(0);
  expect(runtime.queueRuntime.length).toBe(3);
});

test.each([
  ["soft", 100],
  ["hard", 300],
] as const)(
  "durable rehydration rejection at %s capacity is observational on paused work",
  (_boundary, capacity) => {
    const runtime = createDurableRuntime();
    expect(
      enqueueInboundUserMessage(runtime, durableIncoming("paused-existing")),
    ).toBe(true);
    for (let index = 1; index < capacity; index += 1) {
      expect(
        runtime.queueRuntime.enqueue(approvalBarrier(`barrier-${index}`)),
      ).not.toBeNull();
    }
    expect(runtime.queueRuntime.pause()).toBe(1);
    admitQueuedInputs(runtime, 1, `rejected-${capacity}`);
    const itemIds = runtime.queueRuntime.items.map((item) => item.id);
    const trackedMessages = runtime.queuedMessagesByItemId.size;

    expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(0);
    expect(runtime.queueRuntime.pausedCount).toBe(1);
    expect(runtime.queueRuntime.items.map((item) => item.id)).toEqual(itemIds);
    expect(runtime.queuedMessagesByItemId.size).toBe(trackedMessages);
    expect(loadDurableQueuedInputEntries(runtime.listener)).toHaveLength(1);
    expect(restoreDurableQueuedInputs(runtime.listener, undefined, [])).toBe(0);
    expect(runtime.queueRuntime.items.map((item) => item.id)).toEqual(itemIds);
    expect(runtime.queueRuntime.pausedCount).toBe(1);
  },
);

async function waitFor(
  assertion: () => void,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  let failure: unknown;
  while (performance.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(5);
    }
  }
  throw failure;
}

test("lifecycle refill contains async failures and retries one coalesced bounded cycle", async () => {
  const runtime = createDurableRuntime();
  await installLifecycleRefill(runtime);
  let calls = 0;
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  runtime.listener.restoreDurableQueuedInputs = (() => {
    calls += 1;
    if (calls <= 2) return Promise.reject(new Error("transient refill"));
    return 0;
  }) as never;
  try {
    for (let index = 0; index < 20; index += 1) {
      runtime.queueRuntime.enqueue(approvalBarrier(`release-${index}`));
    }
    for (let index = 0; index < 20; index += 1) {
      runtime.queueRuntime.tryDequeue(null);
    }
    await waitFor(() => expect(calls).toBe(3));
    await Bun.sleep(50);
    expect(calls).toBe(3);
    expect(unhandled).toEqual([]);
    expect(runtime.listener.durableQueueRestoreTimer).toBeUndefined();
    expect(runtime.listener.durableQueueRestoreScheduled).toBe(false);
    expect(runtime.listener.durableQueueRestoreFailures).toBe(0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    stopRuntime(runtime.listener, true);
    setActiveRuntime(null);
  }
});

test("lifecycle refill persists beyond a transient failure burst without another callback", async () => {
  const runtime = createDurableRuntime();
  await installLifecycleRefill(runtime);
  let calls = 0;
  runtime.listener.restoreDurableQueuedInputs = (() => {
    calls += 1;
    if (calls <= 7) throw new Error("prolonged transient refill");
    return 0;
  }) as never;
  try {
    runtime.queueRuntime.enqueue(approvalBarrier("single-capacity-release"));
    runtime.queueRuntime.tryDequeue(null);
    await waitFor(() => expect(calls).toBe(8), 4_000);
    await Bun.sleep(300);
    expect(calls).toBe(8);
    expect(runtime.listener.durableQueueRestoreTimer).toBeUndefined();
    expect(runtime.listener.durableQueueRestoreScheduled).toBe(false);
    expect(runtime.listener.durableQueueRestoreFailures).toBe(0);

    runtime.listener.restoreDurableQueuedInputs = (() => {
      calls += 1;
      throw new Error("shutdown failure");
    }) as never;
    runtime.queueRuntime.enqueue(approvalBarrier("shutdown-cancel"));
    runtime.queueRuntime.tryDequeue(null);
    await waitFor(() => expect(calls).toBe(9));
    stopRuntime(runtime.listener, true);
    await Bun.sleep(300);
    expect(calls).toBe(9);
    expect(runtime.listener.durableQueueRestoreTimer).toBeUndefined();
  } finally {
    stopRuntime(runtime.listener, true);
    setActiveRuntime(null);
  }
});

test("lifecycle refill drains hard overflow without duplicates or forgets", async () => {
  const runtime = createDurableRuntime();
  admitQueuedInputs(runtime, 301, "cm-hard");
  for (let index = 0; index < 300; index += 1) {
    const barrier = {
      kind: "approval_result" as const,
      source: "system" as const,
      text: `barrier-${index}`,
      agentId: runtime.agentId ?? undefined,
      conversationId: runtime.conversationId,
    } as Parameters<QueueRuntime["enqueue"]>[0];
    expect(runtime.queueRuntime.enqueue(barrier)).not.toBeNull();
  }
  const restore = await installLifecycleRefill(runtime);
  try {
    expect(restore).toHaveBeenCalledTimes(1);
    expect(runtime.queueRuntime.length).toBe(300);
    for (let index = 0; index < 300; index += 1) {
      expect(runtime.queueRuntime.tryDequeue(null)?.items).toHaveLength(1);
    }
    await Promise.resolve();
    expect(restore).toHaveBeenCalledTimes(2);
    expect(runtime.queueRuntime.length).toBe(100);

    const restored: string[] = [];
    while (!runtime.queueRuntime.isEmpty) {
      const turn = consumeQueuedTurn(runtime);
      expect(turn).not.toBeNull();
      for (const identity of turn?.queuedTurn.durableInputIdentities ?? []) {
        restored.push(identity.id);
      }
      await Promise.resolve();
    }
    expect(restore).toHaveBeenCalledTimes(6);
    expect(restored).toHaveLength(301);
    expect(new Set(restored).size).toBe(301);
  } finally {
    stopRuntime(runtime.listener, true);
    setActiveRuntime(null);
  }
});
