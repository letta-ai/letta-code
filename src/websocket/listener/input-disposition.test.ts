import { afterEach, expect, mock, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  ACCEPTED_INPUT_DISPOSITION_TTL_MS,
  forgetQueuedInputDisposition,
  getInputDisposition,
  MAX_ACCEPTED_INPUT_DISPOSITIONS,
  MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE,
  ordinaryInputIdentity,
  rememberInputDisposition,
  reserveInputDisposition,
  rollbackInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import {
  adoptListenerClientReplacement,
  createListenerClientReplacement,
} from "./listener-replacement";
import { getConversationRuntime, setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

const options: StartListenerOptions = {
  connectionId: "test-connection",
  wsUrl: "local://test",
  deviceId: "device",
  connectionName: "test",
  onConnected: () => {},
  onDisconnected: () => {},
  onError: () => {},
};

function incoming(clientMessageId: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conversation-1",
    messages: [
      {
        role: "user",
        content: clientMessageId,
        client_message_id: clientMessageId,
      },
    ],
  };
}

afterEach(() => setActiveRuntime(null));

test("completed input replay survives idle runtime eviction", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const firstRuntime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const processIncomingMessage = mock(async () => {});
  const acknowledgements: Array<{
    accepted: boolean;
    disposition?: "started" | "queued";
  }> = [];

  dispatchInboundMessageWhenReady({
    listener,
    runtime: firstRuntime,
    incoming: incoming("cm-stable"),
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage,
    trackListenerError: () => {},
    onInputAccepted: (ack) => acknowledgements.push(ack),
  });
  await firstRuntime.messageQueue;
  expect(
    getConversationRuntime(listener, "agent-1", "conversation-1"),
  ).toBeNull();

  const replacementRuntime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  dispatchInboundMessageWhenReady({
    listener,
    runtime: replacementRuntime,
    incoming: incoming("cm-stable"),
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage,
    trackListenerError: () => {},
    onInputAccepted: (ack) => acknowledgements.push(ack),
  });
  await replacementRuntime.messageQueue;

  expect(processIncomingMessage).toHaveBeenCalledTimes(1);
  expect(acknowledgements).toEqual([
    { accepted: true, disposition: "started" },
    { accepted: true, disposition: "started" },
  ]);
});

test("accepted tombstone transfers only through explicit listener replacement", () => {
  const original = createRuntime();
  // The retry-exhausted path re-registers while its predecessor is still the
  // active runtime, so that is the authoritative issuer here.
  setActiveRuntime(original);
  const originalRuntime = getOrCreateScopedRuntime(
    original,
    "agent-1",
    "conversation-1",
  );
  rememberInputDisposition(
    originalRuntime,
    ordinaryInputIdentity("ack-lost"),
    "started",
  );
  const replacement = createListenerClientReplacement(original, options);

  const unrelated = createRuntime();
  const unrelatedRuntime = getOrCreateScopedRuntime(
    unrelated,
    "agent-1",
    "conversation-1",
  );
  expect(
    getInputDisposition(unrelatedRuntime, ordinaryInputIdentity("ack-lost")),
  ).toBeUndefined();
  expect(() =>
    adoptListenerClientReplacement(unrelated, {
      ...options,
      connectionName: "other-account-lineage",
      replacement,
    }),
  ).toThrow("Invalid listener replacement lineage");
  expect(() =>
    adoptListenerClientReplacement(unrelated, {
      ...options,
      replacement: { ...replacement },
    }),
  ).toThrow("Invalid listener replacement lineage");

  const next = createRuntime();
  adoptListenerClientReplacement(next, { ...options, replacement });
  expect(() =>
    adoptListenerClientReplacement(createRuntime(), {
      ...options,
      replacement,
    }),
  ).toThrow("Invalid listener replacement lineage");
  const nextRuntime = getOrCreateScopedRuntime(
    next,
    "agent-1",
    "conversation-1",
  );
  const otherScope = getOrCreateScopedRuntime(
    next,
    "agent-1",
    "conversation-2",
  );
  expect(
    getInputDisposition(nextRuntime, ordinaryInputIdentity("ack-lost")),
  ).toBe("started");
  expect(
    getInputDisposition(otherScope, ordinaryInputIdentity("ack-lost")),
  ).toBeUndefined();
});

test("soft-limit eviction forgets queued acceptance so retry restores work", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  for (let index = 0; index <= 100; index += 1) {
    const clientMessageId = `cm-${index}`;
    expect(enqueueInboundUserMessage(runtime, incoming(clientMessageId))).toBe(
      true,
    );
    rememberInputDisposition(
      runtime,
      ordinaryInputIdentity(clientMessageId),
      "queued",
    );
  }

  expect(runtime.queueRuntime.length).toBe(100);
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-0")),
  ).toBeUndefined();
  expect(enqueueInboundUserMessage(runtime, incoming("cm-0"))).toBe(true);
  expect(runtime.queueRuntime.peek().at(-1)?.clientMessageId).toBe("cm-0");
});

test("per-scope capacity rejects before execution without dropping a tombstone", async () => {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  const otherRuntime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-2",
  );
  expect(
    rememberInputDisposition(
      runtime,
      ordinaryInputIdentity("same-id"),
      "started",
    ),
  ).toBe(true);
  expect(
    getInputDisposition(otherRuntime, ordinaryInputIdentity("same-id")),
  ).toBeUndefined();
  for (
    let index = 1;
    index < MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE;
    index += 1
  ) {
    expect(
      rememberInputDisposition(
        runtime,
        ordinaryInputIdentity(`bounded-${index}`),
        "started",
      ),
    ).toBe(true);
  }

  const processIncomingMessage = mock(async () => {});
  const acknowledgements: boolean[] = [];
  dispatchInboundMessageWhenReady({
    listener,
    runtime,
    incoming: incoming("excess"),
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage,
    trackListenerError: () => {},
    onInputAccepted: ({ accepted }) => acknowledgements.push(accepted),
  });
  await runtime.messageQueue;

  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(runtime.queueRuntime.length).toBe(0);
  expect(acknowledgements).toEqual([false]);
  expect(getInputDisposition(runtime, ordinaryInputIdentity("same-id"))).toBe(
    "started",
  );
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(
    MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE,
  );
});

test("global capacity rejects excess work without evicting prior scopes", async () => {
  const listener = createRuntime();
  const scopeCount =
    MAX_ACCEPTED_INPUT_DISPOSITIONS / MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE;
  for (let scope = 0; scope < scopeCount; scope += 1) {
    const runtime = getOrCreateScopedRuntime(
      listener,
      `agent-${scope}`,
      `conversation-${scope}`,
    );
    for (
      let index = 0;
      index < MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE;
      index += 1
    ) {
      expect(
        rememberInputDisposition(
          runtime,
          ordinaryInputIdentity(`id-${index}`),
          "started",
        ),
      ).toBe(true);
    }
  }
  const first = getOrCreateScopedRuntime(listener, "agent-0", "conversation-0");
  const excess = getOrCreateScopedRuntime(
    listener,
    "agent-excess",
    "conversation-excess",
  );

  setActiveRuntime(listener);
  const processIncomingMessage = mock(async () => {});
  const acknowledgements: boolean[] = [];
  dispatchInboundMessageWhenReady({
    listener,
    runtime: excess,
    incoming: incoming("excess"),
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    options,
    processQueuedTurn: async () => {},
    processIncomingMessage,
    trackListenerError: () => {},
    onInputAccepted: ({ accepted }) => acknowledgements.push(accepted),
  });
  await excess.messageQueue;

  expect(processIncomingMessage).not.toHaveBeenCalled();
  expect(excess.queueRuntime.length).toBe(0);
  expect(acknowledgements).toEqual([false]);
  expect(getInputDisposition(first, ordinaryInputIdentity("id-0"))).toBe(
    "started",
  );
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(
    MAX_ACCEPTED_INPUT_DISPOSITIONS,
  );
});

test("ledger expires entries after the full sender retry horizon", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  rememberInputDisposition(
    runtime,
    ordinaryInputIdentity("expired-id"),
    "started",
  );
  const entry = listener.acceptedInputDispositionLedger.entries
    .values()
    .next().value;
  const expiry = listener.acceptedInputDispositionLedger.expiryQueue[0];
  expect(entry).toBeDefined();
  expect(expiry).toBeDefined();
  if (entry && expiry) {
    entry.acceptedAt = Date.now() - ACCEPTED_INPUT_DISPOSITION_TTL_MS;
    entry.expiresAt = Date.now();
    expiry.expiresAt = entry.expiresAt;
  }
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("expired-id")),
  ).toBeUndefined();
});

test("rolled-back admissions do not grow the expiry index", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  for (let index = 0; index < 10_000; index += 1) {
    const admission = reserveInputDisposition(
      runtime,
      ordinaryInputIdentity(`rolled-back-${index}`),
    );
    expect(admission.kind).toBe("reserved");
    if (admission.kind === "reserved") {
      rollbackInputDisposition(runtime, admission.reservation);
    }
  }
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(0);
  expect(listener.acceptedInputDispositionLedger.scopeCounts.size).toBe(0);
  expect(listener.acceptedInputDispositionLedger.expiryQueue).toEqual([]);
});

test("discard churn keeps stale expiry records bounded", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  for (let index = 0; index < 10_000; index += 1) {
    const clientMessageId = `discarded-${index}`;
    expect(
      rememberInputDisposition(
        runtime,
        ordinaryInputIdentity(clientMessageId),
        "queued",
      ),
    ).toBe(true);
    forgetQueuedInputDisposition(
      runtime,
      ordinaryInputIdentity(clientMessageId),
    );
  }
  expect(listener.acceptedInputDispositionLedger.entries.size).toBe(0);
  expect(listener.acceptedInputDispositionLedger.scopeCounts.size).toBe(0);
  expect(
    listener.acceptedInputDispositionLedger.expiryQueue.length,
  ).toBeLessThanOrEqual(1024);
});

test("explicit remove and clear forget queued acceptance", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  for (const clientMessageId of ["cm-remove", "cm-clear"]) {
    expect(enqueueInboundUserMessage(runtime, incoming(clientMessageId))).toBe(
      true,
    );
    rememberInputDisposition(
      runtime,
      ordinaryInputIdentity(clientMessageId),
      "queued",
    );
  }

  const removeItem = runtime.queueRuntime
    .peek()
    .find((item) => item.clientMessageId === "cm-remove");
  expect(removeItem).toBeDefined();
  expect(
    runtime.queueRuntime.removeItem(removeItem?.id ?? "missing"),
  ).not.toBeNull();
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-remove")),
  ).toBeUndefined();

  runtime.queueRuntime.clear("cancelled");
  expect(
    getInputDisposition(runtime, ordinaryInputIdentity("cm-clear")),
  ).toBeUndefined();
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
});
