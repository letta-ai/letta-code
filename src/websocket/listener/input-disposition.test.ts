import { afterEach, expect, mock, test } from "bun:test";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  ACCEPTED_INPUT_DISPOSITION_TTL_MS,
  getInputDisposition,
  MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE,
  rememberInputDisposition,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
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
    rememberInputDisposition(runtime, clientMessageId, "queued");
  }

  expect(runtime.queueRuntime.length).toBe(100);
  expect(getInputDisposition(runtime, "cm-0")).toBeUndefined();
  expect(enqueueInboundUserMessage(runtime, incoming("cm-0"))).toBe(true);
  expect(runtime.queueRuntime.peek().at(-1)?.clientMessageId).toBe("cm-0");
});

test("ledger is scope-exact and preserves the prior per-scope bound", () => {
  const listener = createRuntime();
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
  rememberInputDisposition(runtime, "same-id", "started");
  expect(getInputDisposition(otherRuntime, "same-id")).toBeUndefined();

  for (
    let index = 0;
    index <= MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE;
    index += 1
  ) {
    rememberInputDisposition(runtime, `bounded-${index}`, "started");
  }
  expect(listener.acceptedInputDispositions?.size).toBe(
    MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE,
  );
  expect(getInputDisposition(runtime, "same-id")).toBeUndefined();
});

test("ledger expires entries after the full sender retry horizon", () => {
  const listener = createRuntime();
  const runtime = getOrCreateScopedRuntime(
    listener,
    "agent-1",
    "conversation-1",
  );
  rememberInputDisposition(runtime, "expired-id", "started");
  const entry = listener.acceptedInputDispositions?.values().next().value;
  expect(entry).toBeDefined();
  if (entry) {
    entry.acceptedAt = Date.now() - ACCEPTED_INPUT_DISPOSITION_TTL_MS;
  }
  expect(getInputDisposition(runtime, "expired-id")).toBeUndefined();
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
    rememberInputDisposition(runtime, clientMessageId, "queued");
  }

  const removeItem = runtime.queueRuntime
    .peek()
    .find((item) => item.clientMessageId === "cm-remove");
  expect(removeItem).toBeDefined();
  expect(
    runtime.queueRuntime.removeItem(removeItem?.id ?? "missing"),
  ).not.toBeNull();
  expect(getInputDisposition(runtime, "cm-remove")).toBeUndefined();

  runtime.queueRuntime.clear("cancelled");
  expect(getInputDisposition(runtime, "cm-clear")).toBeUndefined();
  expect(runtime.queuedMessagesByItemId.size).toBe(0);
});
