import { describe, expect, mock, test } from "bun:test";

// ── Mocks ───────────────────────────────────────────────────────────

// Track sendPresenceUpdate calls so tests can assert typing behavior.
let presenceCalls: { presence: string; jid?: string }[] = [];

function makeFakeSocket() {
  return {
    ev: {
      on: mock(() => {}),
    },
    ws: { close: mock(() => {}) },
    user: { id: "15551234567@s.whatsapp.net", lid: null },
    signalRepository: { lidMapping: new Map() },
    sendMessage: mock(async () => ({ key: { id: "sent-1" } })),
    sendPresenceUpdate: mock(async (presence: string, jid?: string) => {
      presenceCalls.push({ presence, jid });
    }),
    groupMetadata: mock(async () => ({ subject: "Test Group" })),
    chatModify: mock(async () => {}),
  };
}

const currentFakeSocket = makeFakeSocket();

mock.module("@/channels/whatsapp/runtime", () => ({
  loadWhatsAppModule: async () => ({
    downloadContentFromMessage: mock(async () => {
      const chunks: Uint8Array[] = [new Uint8Array(0)];
      return (async function* () {
        yield* chunks;
      })();
    }),
  }),
}));

mock.module("@/channels/whatsapp/session", () => ({
  createWhatsAppSocket: async () => ({
    sock: currentFakeSocket,
    release: () => {},
  }),
  getWhatsAppAuthDir: () => "/tmp/whatsapp-test-auth",
}));

mock.module("@/channels/whatsapp/state", () => ({
  setWhatsAppConnectionState: () => {},
}));

const { createWhatsAppAdapter } = await import("@/channels/whatsapp/adapter");

// ── Helpers ─────────────────────────────────────────────────────────

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    channel: "whatsapp" as const,
    accountId: "test",
    enabled: true,
    dmPolicy: "pairing" as const,
    allowedUsers: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    agentId: "agent-test",
    selfChatMode: false,
    groupMode: "disabled" as const,
    waitingBehavior: "typing_indicator" as const,
    ...overrides,
  };
}

function makeSource(chatId = "15551234567@s.whatsapp.net") {
  return {
    channel: "whatsapp",
    accountId: "test",
    chatId,
    chatType: "direct" as const,
    messageId: "msg-1",
    agentId: "agent-test",
    conversationId: "conv-test",
  };
}

function resetPresence() {
  presenceCalls = [];
  currentFakeSocket.sendPresenceUpdate = mock(
    async (presence: string, jid?: string) => {
      presenceCalls.push({ presence, jid });
    },
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe("WhatsApp typing indicator lifecycle", () => {
  test("starts typing on processing event when waitingBehavior=typing_indicator", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [makeSource()],
    });

    // Should have sent exactly one "composing" presence
    const composing = presenceCalls.filter((c) => c.presence === "composing");
    expect(composing.length).toBe(1);
    expect(composing[0]?.jid).toBe("15551234567@s.whatsapp.net");

    await adapter.stop();
  });

  test("does not start typing when waitingBehavior is off", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(
      makeAccount({ waitingBehavior: "off" }),
    );
    await adapter.start();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [makeSource()],
    });

    expect(presenceCalls.length).toBe(0);
    await adapter.stop();
  });

  test("does not start typing on queued event", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: makeSource(),
    });

    expect(presenceCalls.length).toBe(0);
    await adapter.stop();
  });

  test("stops typing on finished event and sends paused presence", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    const source = makeSource();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source],
    });

    const composingCount = presenceCalls.filter(
      (c) => c.presence === "composing",
    ).length;
    expect(composingCount).toBe(1);

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "b1",
      sources: [source],
      outcome: "completed",
    });

    // Should have sent "paused" to clear the indicator
    const paused = presenceCalls.filter((c) => c.presence === "paused");
    expect(paused.length).toBe(1);
    expect(paused[0]?.jid).toBe("15551234567@s.whatsapp.net");

    await adapter.stop();
  });

  test("stops typing on error outcome", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    const source = makeSource();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source],
    });

    expect(presenceCalls.filter((c) => c.presence === "composing").length).toBe(
      1,
    );

    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "b1",
      sources: [source],
      outcome: "error",
      error: "Something went wrong",
    });

    const paused = presenceCalls.filter((c) => c.presence === "paused");
    expect(paused.length).toBe(1);

    await adapter.stop();
  });

  test("second processing for same source does not duplicate typing loop", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    const source = makeSource();

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source],
    });

    const firstCount = presenceCalls.filter(
      (c) => c.presence === "composing",
    ).length;

    // Same source again — should not create a new entry or send another initial composing
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source],
    });

    const secondCount = presenceCalls.filter(
      (c) => c.presence === "composing",
    ).length;

    expect(secondCount).toBe(firstCount);

    await adapter.stop();
  });

  test("clears all typing on stop", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    const source = makeSource("1234567890@s.whatsapp.net");

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source],
    });

    expect(presenceCalls.filter((c) => c.presence === "composing").length).toBe(
      1,
    );

    await adapter.stop();

    // Wait a tick to ensure any async intervals don't fire
    await new Promise((resolve) => setTimeout(resolve, 50));

    const composingAfterStop = presenceCalls.filter(
      (c) => c.presence === "composing",
    ).length;
    // No additional composing calls should have been made after stop
    expect(composingAfterStop).toBe(1);
  });

  test("multiple sources in same chat share one typing entry", async () => {
    resetPresence();
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    const source1 = makeSource();
    const source1b = { ...makeSource(), messageId: "msg-2" };

    // First source starts typing
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source1],
    });

    // Second source in same chat — should just add ref, not new composing
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "b1",
      sources: [source1b],
    });

    const composingCount = presenceCalls.filter(
      (c) => c.presence === "composing",
    ).length;
    expect(composingCount).toBe(1); // Only one initial composing

    // Finishing first source should NOT clear typing (second source still active)
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "b1",
      sources: [source1],
      outcome: "completed",
    });

    // No "paused" yet because second source is still active
    const pausedAfterFirst = presenceCalls.filter(
      (c) => c.presence === "paused",
    ).length;
    expect(pausedAfterFirst).toBe(0);

    // Finishing second source clears typing
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "b1",
      sources: [source1b],
      outcome: "completed",
    });

    const pausedAfterSecond = presenceCalls.filter(
      (c) => c.presence === "paused",
    ).length;
    expect(pausedAfterSecond).toBe(1);

    await adapter.stop();
  });
});
