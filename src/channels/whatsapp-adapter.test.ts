import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InboundChannelMessage } from "@/channels/types";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
} from "@/channels/whatsapp/adapter";

// ── Mock socket infrastructure ───────────────────────────────────
// The adapter's start() → connect() calls createWhatsAppSocket and
// loadWhatsAppModule. We mock both so tests can drive the adapter into
// a "running" state with a controllable socket.

let lastSendMessageArgs:
  | { jid: string; payload: Record<string, unknown>; options?: Record<string, unknown> }
  | null = null;
let presenceUpdateCalls: Array<{ presence: string; jid: string }> = [];
let messagesUpsertHandler:
  | ((payload: unknown) => void)
  | null = null;

function resetMockState(): void {
  lastSendMessageArgs = null;
  presenceUpdateCalls = [];
  messagesUpsertHandler = null;
}

// Mock socket object shared across tests.
function makeMockSocket() {
  return {
    ev: {
      on: (event: string, handler: (payload?: unknown) => void) => {
        if (event === "messages.upsert") {
          messagesUpsertHandler = handler as (payload: unknown) => void;
        }
      },
    },
    ws: { close: () => {} },
    user: { id: "15551234567@s.whatsapp.net", lid: null },
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
}

mock.module("@/channels/whatsapp/session", () => ({
  createWhatsAppSocket: async (params: {
    onConnectionUpdate?: (update: Record<string, unknown>) => void;
  }) => {
    const sock = makeMockSocket();
    // Fire "open" connection update so the adapter transitions to connected.
    if (params.onConnectionUpdate) {
      params.onConnectionUpdate({ connection: "open" });
    }
    return {
      sock,
      saveCreds: async () => {},
      DisconnectReason: {},
      release: () => {},
    };
  },
  getWhatsAppAuthDir: (accountId: string) =>
    `/tmp/whatsapp-test/${accountId}`,
}));

mock.module("@/channels/whatsapp/runtime", () => ({
  loadWhatsAppModule: async () => ({
    downloadContentFromMessage: async () => {
      throw new Error("not used in adapter tests");
    },
  }),
  loadQrCodeTerminalModule: async () => ({}),
}));

function makeAccount(overrides: Record<string, unknown> = {}) {
  return {
    channel: "whatsapp" as const,
    accountId: "main",
    enabled: true,
    dmPolicy: "pairing" as const,
    allowedUsers: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    agentId: "agent-whatsapp",
    selfChatMode: true,
    groupMode: "disabled" as const,
    ...overrides,
  };
}

afterEach(() => {
  resetMockState();
});

// ── Existing helper tests ────────────────────────────────────────

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
            accountId: "main",
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

// ── Message prefix tests ────────────────────────────────────────

describe("WhatsApp adapter message prefix", () => {
  test("sendMessage prepends account.messagePrefix to text", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ messagePrefix: "🤖 " }),
    );
    await adapter.start();

    await adapter.sendMessage({
      channel: "whatsapp",
      accountId: "main",
      chatId: "15551234567@s.whatsapp.net",
      text: "Hello world",
    });

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "🤖 Hello world" });

    await adapter.stop();
  });

  test("sendMessage does not prepend prefix when messagePrefix is undefined", async () => {
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    await adapter.sendMessage({
      channel: "whatsapp",
      accountId: "main",
      chatId: "15551234567@s.whatsapp.net",
      text: "Hello world",
    });

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "Hello world" });

    await adapter.stop();
  });

  test("sendDirectReply prepends account.messagePrefix to text", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ messagePrefix: "🤖 " }),
    );
    await adapter.start();

    await adapter.sendDirectReply("15551234567@s.whatsapp.net", "Hi there");

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "🤖 Hi there" });

    await adapter.stop();
  });

  test("sendDirectReply does not prepend prefix when undefined", async () => {
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();

    await adapter.sendDirectReply("15551234567@s.whatsapp.net", "Hi there");

    expect(lastSendMessageArgs).not.toBeNull();
    expect(lastSendMessageArgs!.payload).toEqual({ text: "Hi there" });

    await adapter.stop();
  });
});

// ── Typing indicator tests ──────────────────────────────────────

describe("WhatsApp adapter typing indicator", () => {
  test("typing starts on 'processing' lifecycle event when waitingBehavior is typing_indicator", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ waitingBehavior: "typing_indicator" }),
    );
    await adapter.start();
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "main",
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
      makeAccount({ waitingBehavior: "typing_indicator" }),
    );
    await adapter.start();
    presenceUpdateCalls = [];

    // Start typing first.
    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "main",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "msg-1",
          agentId: "agent-whatsapp",
          conversationId: "conv-whatsapp",
        },
      ],
    });

    // Now finish.
    presenceUpdateCalls = [];
    await adapter.handleTurnLifecycleEvent?.({
      type: "finished",
      batchId: "batch-1",
      outcome: "completed",
      stopReason: "end_turn",
      sources: [
        {
          channel: "whatsapp",
          accountId: "main",
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
      makeAccount({ waitingBehavior: "off" }),
    );
    await adapter.start();
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "main",
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
    const adapter = createWhatsAppAdapter(makeAccount());
    await adapter.start();
    presenceUpdateCalls = [];

    await adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "batch-1",
      sources: [
        {
          channel: "whatsapp",
          accountId: "main",
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
      makeAccount({ waitingBehavior: "typing_indicator" }),
    );
    await adapter.start();
    presenceUpdateCalls = [];

    // "queued" events have a single `source`, not `sources`.
    await adapter.handleTurnLifecycleEvent?.({
      type: "queued",
      source: {
        channel: "whatsapp",
        accountId: "main",
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

// ── Inbound debounce tests ──────────────────────────────────────

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
      makeAccount({ inboundDebounceMs: 50, selfChatMode: false }),
    );

    const received: InboundChannelMessage[] = [];
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      received.push(msg);
    };

    await adapter.start();
    expect(messagesUpsertHandler).not.toBeNull();

    // Send two rapid messages.
    messagesUpsertHandler!(makeUpsertEvent("Hello", "msg-a"));
    messagesUpsertHandler!(makeUpsertEvent("World", "msg-b"));

    // Wait for debounce window to flush.
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(received).toHaveLength(1);
    expect(received[0]!.text).toBe("Hello\nWorld");

    await adapter.stop();
  });

  test("debounce is disabled (0ms) by default — each message dispatches immediately", async () => {
    const adapter = createWhatsAppAdapter(
      makeAccount({ selfChatMode: false }),
    );

    const received: InboundChannelMessage[] = [];
    adapter.onMessage = async (msg: InboundChannelMessage) => {
      received.push(msg);
    };

    await adapter.start();
    expect(messagesUpsertHandler).not.toBeNull();

    messagesUpsertHandler!(makeUpsertEvent("First", "msg-c"));
    // With debounceMs=0, flush should be immediate.
    await new Promise((resolve) => setTimeout(resolve, 20));

    messagesUpsertHandler!(makeUpsertEvent("Second", "msg-d"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(received).toHaveLength(2);
    expect(received[0]!.text).toBe("First");
    expect(received[1]!.text).toBe("Second");

    await adapter.stop();
  });
});
