import { afterEach, expect, mock, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getOrCreateScopedRuntime,
  restoreDurableQueuedInputs,
} from "./conversation-runtime";
import { dispatchInboundMessageWhenReady } from "./inbound-dispatch";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  __inputDispositionTestUtils,
  ACCEPTED_INPUT_DISPOSITION_TTL_MS,
  commitInputDisposition,
  completeInputReplay,
  createAcceptedInputDispositionLedger,
  forgetQueuedInputDisposition,
  getInputDisposition,
  loadDurableQueuedInputs,
  MAX_ACCEPTED_INPUT_DISPOSITIONS,
  MAX_ACCEPTED_INPUT_DISPOSITIONS_PER_SCOPE,
  ordinaryInputIdentity,
  rememberInputDisposition,
  reserveInputDisposition,
  rollbackInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { createRuntime } from "./lifecycle";
import {
  adoptListenerClientReplacement,
  createListenerClientReplacement,
} from "./listener-replacement";
import { consumeQueuedTurn } from "./queue";
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

function durableIncoming(clientMessageId: string): IncomingMessage {
  return {
    ...incoming(clientMessageId),
    agentId: "agent-durable",
    conversationId: "conversation-durable",
  };
}

function persistentRuntime(path: string) {
  const listener = createRuntime();
  listener.acceptedInputDispositionLedger =
    createAcceptedInputDispositionLedger({ persistentPath: path });
  return getOrCreateScopedRuntime(
    listener,
    "agent-durable",
    "conversation-durable",
  );
}

test("committed disposition survives a fresh runtime and suppresses restart replay", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-restart-"));
  try {
    const path = join(root, "state", "dispositions.json");
    const first = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-after-crash");
    const admission = reserveInputDisposition(first, identity);
    expect(admission.kind).toBe("reserved");
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(first, admission.reservation, "started", {
        incoming: durableIncoming("cm-after-crash"),
      }),
    ).toBe(true);

    const restarted = persistentRuntime(path);
    expect(reserveInputDisposition(restarted, identity)).toEqual({
      kind: "duplicate",
      disposition: "started",
    });
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
    expect(restarted.queueRuntime.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("filesystem reservation serializes racers and rollback never strands retry", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-race-"));
  try {
    const path = join(root, "state.json");
    const first = persistentRuntime(path);
    const second = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-race");
    const winner = reserveInputDisposition(first, identity);
    expect(winner.kind).toBe("reserved");
    expect(reserveInputDisposition(second, identity)).toEqual({ kind: "full" });
    if (winner.kind !== "reserved") throw new Error("expected reservation");
    rollbackInputDisposition(first, winner.reservation);
    expect(reserveInputDisposition(second, identity).kind).toBe("reserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reservation owned by a crashed process is reclaimed immediately", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-crash-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-crashed-reservation");
    expect(reserveInputDisposition(runtime, identity).kind).toBe("reserved");
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      reservations: Record<
        string,
        { pid: number; processStart: string | null }
      >;
    };
    for (const reservation of Object.values(store.reservations)) {
      reservation.pid = 2_147_483_647;
      reservation.processStart = "dead";
    }
    writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
    expect(
      reserveInputDisposition(persistentRuntime(path), identity).kind,
    ).toBe("reserved");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durable expiry removes completed tombstones but retains replayable work", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-expiry-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const queued = ordinaryInputIdentity("cm-discard-durable");
    expect(
      rememberInputDisposition(runtime, queued, "queued", {
        incoming: durableIncoming("cm-discard-durable"),
      }),
    ).toBe(true);
    forgetQueuedInputDisposition(runtime, queued);
    expect(
      getInputDisposition(persistentRuntime(path), queued),
    ).toBeUndefined();

    const expired = ordinaryInputIdentity("cm-expired-durable");
    if (!expired) throw new Error("expected stable expired identity");
    expect(
      rememberInputDisposition(runtime, expired, "started", {
        incoming: durableIncoming("cm-expired-durable"),
      }),
    ).toBe(true);
    expect(completeInputReplay(runtime, [expired])).toBe(true);
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Record<string, { expiresAt: number }>;
    };
    for (const entry of Object.values(store.entries)) entry.expiresAt = 0;
    writeFileSync(path, JSON.stringify(store), { mode: 0o600 });
    expect(
      getInputDisposition(persistentRuntime(path), expired),
    ).toBeUndefined();

    const replayable = ordinaryInputIdentity("cm-replay-after-horizon");
    if (!replayable) throw new Error("expected stable replay identity");
    expect(
      rememberInputDisposition(runtime, replayable, "started", {
        incoming: durableIncoming("cm-replay-after-horizon"),
      }),
    ).toBe(true);
    const replayStore = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Record<string, { expiresAt: number }>;
    };
    for (const entry of Object.values(replayStore.entries)) entry.expiresAt = 0;
    writeFileSync(path, JSON.stringify(replayStore), { mode: 0o600 });
    const afterHorizon = persistentRuntime(path);
    expect(getInputDisposition(afterHorizon, replayable)).toBe("started");
    expect(loadDurableQueuedInputs(afterHorizon.listener)).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock never evicts a paused live owner based on age", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-live-lock-"));
  try {
    const path = join(root, "state.json");
    const release = __inputDispositionTestUtils.acquireLock(path, 20);
    utimesSync(`${path}.lock`, new Date(0), new Date(0));
    expect(() => __inputDispositionTestUtils.acquireLock(path, 20)).toThrow();
    expect(existsSync(`${path}.lock`)).toBe(true);
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lock release is token-exact and cannot delete a replacement", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-exact-lock-"));
  try {
    const path = join(root, "state.json");
    const releaseOld = __inputDispositionTestUtils.acquireLock(path, 20);
    releaseOld();
    const releaseReplacement = __inputDispositionTestUtils.acquireLock(
      path,
      20,
    );
    releaseOld();
    expect(existsSync(`${path}.lock`)).toBe(true);
    releaseReplacement();
    expect(existsSync(`${path}.lock`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dead lock recovery quarantines only the observed owner", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-dead-lock-"));
  try {
    const path = join(root, "state.json");
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    writeFileSync(
      join(lockPath, "2147483647-dead-owner.json"),
      JSON.stringify({
        token: "dead-owner",
        pid: 2_147_483_647,
        processStart: "dead",
      }),
      { mode: 0o600 },
    );
    const release = __inputDispositionTestUtils.acquireLock(path, 20);
    const ownerFile = readdirSync(lockPath)[0];
    expect(
      ownerFile &&
        JSON.parse(readFileSync(join(lockPath, ownerFile), "utf8")).token,
    ).not.toBe("dead-owner");
    release();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt lock fails closed without deleting it", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-corrupt-lock-"));
  try {
    const path = join(root, "state.json");
    writeFileSync(`${path}.lock`, "not-json", { mode: 0o600 });
    expect(() => __inputDispositionTestUtils.acquireLock(path, 20)).toThrow();
    expect(readFileSync(`${path}.lock`, "utf8")).toBe("not-json");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit-before-enqueue restores complete queued execution context once", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-restore-"));
  try {
    const path = join(root, "state.json");
    const first = persistentRuntime(path);
    const queuedIncoming = {
      ...durableIncoming("cm-restored"),
      clientPreferences: { toolset: { include: ["Read"] } },
    };
    const admission = reserveInputDisposition(
      first,
      ordinaryInputIdentity("cm-restored"),
    );
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(first, admission.reservation, "queued", {
        incoming: queuedIncoming,
        actingUserId: "user-1",
      }),
    ).toBe(true);

    const restarted = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(0);
    expect(restarted.queueRuntime.length).toBe(1);
    const item = restarted.queueRuntime.peek()[0];
    expect(item?.clientMessageId).toBe("cm-restored");
    expect(item?.actingUserId).toBe("user-1");
    expect(
      item && restarted.queuedMessagesByItemId.get(item.id)?.clientPreferences,
    ).toEqual({ toolset: { include: ["Read"] } });
    expect(
      reserveInputDisposition(restarted, ordinaryInputIdentity("cm-restored")),
    ).toEqual({ kind: "duplicate", disposition: "queued" });
    expect(restarted.queueRuntime.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("graceful restore never duplicates an already enqueued durable item", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-graceful-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const queuedIncoming = durableIncoming("cm-graceful");
    const admission = reserveInputDisposition(
      runtime,
      ordinaryInputIdentity("cm-graceful"),
    );
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: queuedIncoming,
      }),
    ).toBe(true);
    expect(enqueueInboundUserMessage(runtime, queuedIncoming)).toBe(true);
    expect(restoreDurableQueuedInputs(runtime.listener)).toBe(0);
    expect(runtime.queueRuntime.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt store blocks explicit discard before volatile removal", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-discard-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const queuedIncoming = durableIncoming("cm-discard-corrupt");
    const admission = reserveInputDisposition(
      runtime,
      ordinaryInputIdentity("cm-discard-corrupt"),
    );
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: queuedIncoming,
      }),
    ).toBe(true);
    expect(enqueueInboundUserMessage(runtime, queuedIncoming)).toBe(true);
    const item = runtime.queueRuntime.peek()[0];
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    expect(runtime.queueRuntime.removeItem(item?.id ?? "missing")).toBeNull();
    expect(runtime.queueRuntime.length).toBe(1);
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dequeue handoff retains replay payload with its started tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-handoff-"));
  try {
    const path = join(root, "state.json");
    const first = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-handoff");
    const admission = reserveInputDisposition(first, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(first, admission.reservation, "queued", {
        incoming: durableIncoming("cm-handoff"),
      }),
    ).toBe(true);
    expect(restoreDurableQueuedInputs(first.listener)).toBe(1);
    expect(consumeQueuedTurn(first)).not.toBeNull();

    const restarted = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(0);
    expect(getInputDisposition(restarted, identity)).toBe("started");
    expect(restarted.queueRuntime.length).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("started teleport restore preserves the teleport identity namespace", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-teleport-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = teleportInputIdentity("tp-restored");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    const incoming: IncomingMessage = {
      type: "message",
      agentId: "agent-durable",
      conversationId: "conversation-durable",
      messages: [
        {
          role: "user",
          content: "continue",
          otid: "tp-restored:continue",
        },
      ],
    };
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming,
      }),
    ).toBe(true);

    const restarted = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(1);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(0);
    const item = restarted.queueRuntime.peek()[0];
    const restored = item && restarted.queuedMessagesByItemId.get(item.id);
    expect(restored?.durableInputIdentities).toEqual([identity]);
    expect(
      reserveInputDisposition(restarted, ordinaryInputIdentity("tp-restored")),
    ).toMatchObject({ kind: "reserved" });
    expect(reserveInputDisposition(restarted, identity)).toEqual({
      kind: "duplicate",
      disposition: "started",
    });
    if (!item) throw new Error("expected restored teleport queue item");
    expect(restarted.queueRuntime.removeItem(item.id)).not.toBeNull();

    const afterDiscard = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(afterDiscard.listener)).toBe(0);
    expect(getInputDisposition(afterDiscard, identity)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal completion strips replay payload but retains duplicate disposition", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-complete-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-completed");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: durableIncoming("cm-completed"),
      }),
    ).toBe(true);
    expect(completeInputReplay(runtime, identity ? [identity] : [])).toBe(true);

    const restarted = persistentRuntime(path);
    expect(restoreDurableQueuedInputs(restarted.listener)).toBe(0);
    expect(getInputDisposition(restarted, identity)).toBe("started");
    const store = JSON.parse(readFileSync(path, "utf8")) as {
      entries: Record<
        string,
        { queuedInput?: unknown; replayCompleted?: true }
      >;
    };
    expect(Object.values(store.entries)[0]?.queuedInput).toBeUndefined();
    expect(Object.values(store.entries)[0]?.replayCompleted).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload retirement failure is reported instead of claiming durable completion", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-strip-failure-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-strip-failure");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    expect(
      commitInputDisposition(runtime, admission.reservation, "started", {
        incoming: durableIncoming("cm-strip-failure"),
      }),
    ).toBe(true);
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    expect(completeInputReplay(runtime, identity ? [identity] : [])).toBe(
      false,
    );
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("oversized queued payload is rejected without a queued tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-size-"));
  try {
    const path = join(root, "state.json");
    const runtime = persistentRuntime(path);
    const identity = ordinaryInputIdentity("cm-too-large");
    const admission = reserveInputDisposition(runtime, identity);
    if (admission.kind !== "reserved") throw new Error("expected reservation");
    const oversized = durableIncoming("cm-too-large");
    oversized.messages[0] = {
      role: "user",
      content: "x".repeat(1024 * 1024 + 1),
      client_message_id: "cm-too-large",
    };
    expect(
      commitInputDisposition(runtime, admission.reservation, "queued", {
        incoming: oversized,
      }),
    ).toBe(false);
    rollbackInputDisposition(runtime, admission.reservation);
    expect(getInputDisposition(runtime, identity)).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt durable store fails closed and is never overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-corrupt-store-"));
  try {
    const path = join(root, "state.json");
    writeFileSync(path, "{corrupt", { mode: 0o600 });
    const runtime = persistentRuntime(path);
    expect(
      reserveInputDisposition(runtime, ordinaryInputIdentity("cm-corrupt")),
    ).toEqual({ kind: "full" });
    expect(() => restoreDurableQueuedInputs(runtime.listener)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("{corrupt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("durability failure rejects admission without an in-memory tombstone", () => {
  const root = mkdtempSync(join(tmpdir(), "letta-disposition-failure-"));
  try {
    const directoryAsStore = join(root, "not-a-file");
    const runtime = persistentRuntime(directoryAsStore);
    // Make the configured store path itself a directory, forcing reads/writes to
    // fail closed rather than allowing accepted work without restart durability.
    mkdirSync(directoryAsStore);
    expect(
      reserveInputDisposition(runtime, ordinaryInputIdentity("cm-failure")),
    ).toEqual({ kind: "full" });
    expect(runtime.listener.acceptedInputDispositionLedger.entries.size).toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
