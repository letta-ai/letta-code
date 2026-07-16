import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InboundChannelMessage } from "@/channels/types";

// ── Module mocks ──────────────────────────────────────────────────────
//
// The adapter loads the Baileys runtime lazily via `loadWhatsAppModule`
// and creates a socket via `createWhatsAppSocket`. We mock both so the
// tests can drive the inbound handler without a real WhatsApp connection.

let mockReadMessages: ReturnType<typeof mock> = mock(async () => {});
let lastSendMessageArgs: {
  jid: string;
  payload: Record<string, unknown>;
  options?: Record<string, unknown>;
} | null = null;
let presenceUpdateCalls: Array<{ presence: string; jid: string }> = [];
let connectionUpdateHandler:
  | ((update: Record<string, unknown>) => void)
  | null = null;
let messagesUpsertHandler: ((event: unknown) => void) | null = null;

mock.module("@/channels/whatsapp/runtime", () => ({
  loadWhatsAppModule: async () => ({
    downloadContentFromMessage: () => undefined,
  }),
  loadQrCodeTerminalModule: async () => ({}),
}));

mock.module("@/channels/whatsapp/session", () => ({
  getWhatsAppAuthDir: (accountId: string) =>
    `/tmp/test-whatsapp-auth-${accountId}`,
  createWhatsAppSocket: async (params: {
    onConnectionUpdate?: (update: Record<string, unknown>) => void;
  }) => {
    connectionUpdateHandler = params.onConnectionUpdate ?? null;
    const sock = {
      ev: {
        on: (event: string, handler: (event: unknown) => void) => {
          if (event === "messages.upsert") {
            messagesUpsertHandler = handler;
          }
        },
      },
      ws: { close: () => {} },
      user: { id: "15551234567@s.whatsapp.net", lid: "lid:12345@lid" },
      readMessages: mockReadMessages,
      sendMessage: async (
        jid: string,
        payload: Record<string, unknown>,
        options?: Record<string, unknown>,
      ) => {
        lastSendMessageArgs = { jid, payload, options };
        return { key: { id: "sent-msg-id" }, message: payload };
      },
      sendPresenceUpdate: async (presence: string, jid?: string) => {
        presenceUpdateCalls.push({ presence, jid: jid ?? "" });
      },
      groupMetadata: async () => ({ subject: "Test Group" }),
    };
    return {
      sock,
      release: () => {},
    };
  },
}));

// ── Import adapter AFTER mocks are registered ─────────────────────────

const { createWhatsAppAdapter, isWhatsAppConflictDisconnect } = await import(
  "@/channels/whatsapp/adapter"
);

// ── Helpers ───────────────────────────────────────────────────────────

function makeInboundMessage(overrides?: {
  remoteJid?: string;
  fromMe?: boolean;
  text?: string;
  messageId?: string;
  participant?: string | null;
  senderPn?: string | null;
}) {
  return {
    key: {
      remoteJid: overrides?.remoteJid ?? "15557654321@s.whatsapp.net",
      id: overrides?.messageId ?? "msg-inbound-1",
      fromMe: overrides?.fromMe ?? false,
      participant: overrides?.participant ?? null,
      senderPn: overrides?.senderPn ?? null,
    },
    message: {
      conversation: overrides?.text ?? "Hello from test",
    },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: "Test Sender",
  };
}

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    channel: "whatsapp" as const,
    accountId: "test",
    enabled: true,
    dmPolicy: "pairing" as const,
    allowedUsers: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    agentId: "agent-whatsapp",
    selfChatMode: false,
    groupMode: "disabled" as const,
    ...overrides,
  };
}

function emitMessagesUpsert(messages: unknown[], type = "notify") {
  messagesUpsertHandler?.({ type, messages });
}

async function startAdapterAndConnect(
  adapter: ReturnType<typeof createWhatsAppAdapter>,
) {
  await adapter.start();
  // Simulate connection open so selfPhoneJid / selfLid are set.
  connectionUpdateHandler?.({ connection: "open" });
}

function resetMockState(): void {
  lastSendMessageArgs = null;
  presenceUpdateCalls = [];
}

afterEach(() => {
  mockReadMessages.mockClear();
  messagesUpsertHandler = null;
  connectionUpdateHandler = null;
  resetMockState();
});

// ── Helper tests ──────────────────────────────────────────────────────

describe("WhatsApp adapter helpers", () => {
  test("detects session conflict disconnects by message", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
      }),
    ).toBe(true);
  });

  test("detects session conflict disconnects by status code", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { output: { statusCode: 440 } } },
      }),
    ).toBe(true);
  });

  test("ignores non-conflict disconnects", () => {
    expect(
      isWhatsAppConflictDisconnect({
        connection: "close",
        lastDisconnect: { error: { message: "timed out" } },
      }),
    ).toBe(false);
  });

  test("implements turn lifecycle event handling", async () => {
    const adapter = createWhatsAppAdapter(makeAccount());

    expect(adapter.handleTurnLifecycleEvent).toBeTypeOf("function");

    await expect(
      adapter.handleTurnLifecycleEvent?.({
        type: "finished",
        batchId: "batch-1",
        outcome: "error",
        stopReason: "error",
        error: "Turn failed",
        sources: [
          {
            channel: "whatsapp",
            accountId: "test",
            chatId: "15551234567@s.whatsapp.net",
            messageId: "msg-1",
            agentId: "agent-whatsapp",
            conversationId: "conv-whatsapp",
          },
        ],
      }),
    ).resolves.toBeUndefined();
  });
});

// ── Read receipt tests ────────────────────────────────────────────────

describe("WhatsApp adapter read receipts", () => {
  test("calls readMessages with message key on inbound DM", async () => {
    const account = makeAccount({ accountId: "test-read-receipts" });
    const adapter = createWhatsAppAdapter(account);
    const onMessage = mock(async (_msg: InboundChannelMessage) => {});
    adapter.onMessage = onMessage;

    await startAdapterAndConnect(adapter);

    const msg = makeInboundMessage({
      messageId: "rr-test-1",
      remoteJid: "15557654321@s.whatsapp.net",
    });
    emitMessagesUpsert([msg]);

    // Wait for the async handler to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReadMessages).toHaveBeenCalledTimes(1);
    const keysArg = mockReadMessages.mock.calls[0]?.[0];
    expect(Array.isArray(keysArg)).toBe(true);
    expect(keysArg[0]).toEqual(msg.key);

    await adapter.stop();
  });

  test("does not crash when readMessages throws", async () => {
    const warnSpy = mock(() => {});
    const originalWarn = console.warn;
    console.warn = warnSpy as unknown as typeof console.warn;

    mockReadMessages = mock(async () => {
      throw new Error("Network error");
    });

    const account = makeAccount({ accountId: "test-read-error" });
    const adapter = createWhatsAppAdapter(account);
    const onMessage = mock(async (_msg: InboundChannelMessage) => {});
    adapter.onMessage = onMessage;

    await startAdapterAndConnect(adapter);

    const msg = makeInboundMessage({
      messageId: "rr-test-2",
      remoteJid: "15559998888@s.whatsapp.net",
    });
    emitMessagesUpsert([msg]);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockReadMessages).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
    await adapter.stop();
  });

  test("calls readMessages for each message in a batch", async () => {
    mockReadMessages = mock(async () => {});

    const account = makeAccount({ accountId: "test-read-batch" });
    const adapter = createWhatsAppAdapter(account);
    const onMessage = mock(async (_msg: InboundChannelMessage) => {});
    adapter.onMessage = onMessage;

    await startAdapterAndConnect(adapter);

    const msgs = [
      makeInboundMessage({
        messageId: "rr-batch-1",
        remoteJid: "15551110000@s.whatsapp.net",
      }),
      makeInboundMessage({
        messageId: "rr-batch-2",
        remoteJid: "15552220000@s.whatsapp.net",
      }),
    ];
    emitMessagesUpsert(msgs);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(mockReadMessages).toHaveBeenCalledTimes(2);

    await adapter.stop();
  });
});

// ── Message prefix tests ──────────────────────────────────────────────

describe("WhatsApp adapter message prefix", () => {
  test("sendMessage prepends account.messagePrefix to text", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "prefix-test",
        messagePrefix: "🤖 ",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);

    await adapter.sendMessage({
      channel: "whatsapp",
      accountId: "prefix-test",
      chatId: "15551234567@s.whatsapp.net",
      text: "Hello world",
    });

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "🤖 Hello world" });

    await adapter.stop();
  });

  test("sendMessage does not prepend prefix when messagePrefix is undefined", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ accountId: "prefix-none", selfChatMode: true }),
    );
    await startAdapterAndConnect(adapter);

    await adapter.sendMessage({
      channel: "whatsapp",
      accountId: "prefix-none",
      chatId: "15551234567@s.whatsapp.net",
      text: "Hello world",
    });

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "Hello world" });

    await adapter.stop();
  });

  test("sendDirectReply prepends account.messagePrefix to text", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "prefix-direct",
        messagePrefix: "🤖 ",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);

    await adapter.sendDirectReply("15551234567@s.whatsapp.net", "Hi there");

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "🤖 Hi there" });

    await adapter.stop();
  });

  test("sendDirectReply does not prepend prefix when undefined", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ accountId: "prefix-direct-none", selfChatMode: true }),
    );
    await startAdapterAndConnect(adapter);

    await adapter.sendDirectReply("15551234567@s.whatsapp.net", "Hi there");

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "Hi there" });

    await adapter.stop();
  });
});

// ── Typing indicator tests ────────────────────────────────────────────

describe("WhatsApp adapter typing indicator", () => {
  test("typing starts on 'processing' lifecycle event when waitingBehavior is typing_indicator", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "typing-test",
        waitingBehavior: "typing_indicator",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "typing-test",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    expect(presenceUpdateCalls).toContainEqual({
      presence: "composing",
      jid: "15551234567@s.whatsapp.net",
    });

    await adapter.stop();
  });

  test("typing clears on 'finished' lifecycle event (sends 'paused')", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "typing-clear",
        waitingBehavior: "typing_indicator",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);

    // Start typing first.
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "typing-clear",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    presenceUpdateCalls = [];
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      outcome: "completed",
      stopReason: "end_turn",
      sources: [
        {
          channel: "whatsapp",
          accountId: "typing-clear",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    expect(presenceUpdateCalls).toContainEqual({
      presence: "paused",
      jid: "15551234567@s.whatsapp.net",
    });

    await adapter.stop();
  });

  test("typing is not started when waitingBehavior is 'off'", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "typing-off",
        waitingBehavior: "off",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "typing-off",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    expect(presenceUpdateCalls).toHaveLength(0);

    await adapter.stop();
  });

  test("typing is not started when waitingBehavior is undefined", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ accountId: "typing-undef", selfChatMode: true }),
    );
    await startAdapterAndConnect(adapter);
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "typing-undef",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    expect(presenceUpdateCalls).toHaveLength(0);

    await adapter.stop();
  });

  test("'queued' lifecycle event does not start typing", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({
        accountId: "typing-queued",
        waitingBehavior: "typing_indicator",
        selfChatMode: true,
      }),
    );
    await startAdapterAndConnect(adapter);
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: {
        channel: "whatsapp",
        accountId: "typing-queued",
        chatId: "15551234567@s.whatsapp.net",
        messageId: "msg-1",
        agentId: "agent-whatsapp",
        conversationId: "conv-whatsapp",
      },
    });

    expect(presenceUpdateCalls).toHaveLength(0);

    await adapter.stop();
  });
});

// ── Inbound debounce tests ────────────────────────────────────────────

function makeUpsertEvent(
  text: string,
  messageId: string,
  remoteJid = "15551234567@s.whatsapp.net",
) {
  return {
    type: "notify",
    messages: [
      {
        key: { remoteJid, id: messageId, fromMe: false },
        message: { conversation: text },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: "TestUser",
      },
    ],
  };
}

describe("WhatsApp adapter inbound debounce", () => {
  test("two rapid text messages get combined into one dispatch", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ accountId: "debounce-test", inboundDebounceMs: 50 }),
    );

    const received: InboundChannelMessage[] = [];
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      received.push(msg);
    };

    await startAdapterAndConnect(adapter);
    expect(messagesUpsertHandler).not.toBeNull();

    messagesUpsertHandler!(makeUpsertEvent("Hello", "msg-a"));
    messagesUpsertHandler!(makeUpsertEvent("World", "msg-b"));

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("Hello\nWorld");

    await adapter.stop();
  });

  test("debounce is disabled (0ms) by default — each message dispatches immediately", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ accountId: "debounce-none" }),
    );

    const received: InboundChannelMessage[] = [];
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      received.push(msg);
    };

    await startAdapterAndConnect(adapter);
    expect(messagesUpsertHandler).not.toBeNull();

    messagesUpsertHandler!(makeUpsertEvent("First", "msg-c"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    messagesUpsertHandler!(makeUpsertEvent("Second", "msg-d"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    expect(received[0]!.text).toBe("First");
    expect(received[1]!.text).toBe("Second");

    await adapter.stop();
  });
});
