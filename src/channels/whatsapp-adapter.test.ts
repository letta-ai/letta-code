import { afterEach, describe, expect, mock, test } from "bun:test";
import type { InboundChannelMessage } from "@/channels/types";

// ── Module mocks ──────────────────────────────────────────────────────
//
// The adapter loads the Baileys runtime lazily via `loadWhatsAppModule`
// and creates a socket via `createWhatsAppSocket`. We mock both so the
// tests can drive the inbound handler without a real WhatsApp connection.

let mockReadMessages: ReturnType<typeof mock> = mock(async () => {});
const mockSendMessage: ReturnType<typeof mock> = mock(async () => ({}));
const mockSendPresenceUpdate: ReturnType<typeof mock> = mock(async () => {});
let connectionUpdateHandler:
  | ((update: Record<string, unknown>) => void)
  | null = null;
let messagesUpsertHandler: ((event: unknown) => void) | null = null;

mock.module("@/channels/whatsapp/runtime", () => ({
  loadWhatsAppModule: async () => ({
    downloadContentFromMessage: () => undefined,
  }),
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
      sendMessage: mockSendMessage,
      sendPresenceUpdate: mockSendPresenceUpdate,
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

function makeSelfChatAccount() {
  return {
    channel: "whatsapp" as const,
    accountId: "test-read-receipts",
    enabled: true,
    dmPolicy: "pairing" as const,
    allowedUsers: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    agentId: "agent-whatsapp",
    selfChatMode: false,
    groupMode: "disabled" as const,
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

// ── Tests ─────────────────────────────────────────────────────────────

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
    const adapter = createWhatsAppAdapter({
      channel: "whatsapp",
      accountId: "main",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
    });

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

describe("WhatsApp adapter read receipts", () => {
  afterEach(() => {
    mockReadMessages.mockClear();
    mockSendMessage.mockClear();
    mockSendPresenceUpdate.mockClear();
    messagesUpsertHandler = null;
    connectionUpdateHandler = null;
  });

  test("calls readMessages with message key on inbound DM", async () => {
    const account = makeSelfChatAccount();
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

    // Re-register the session mock with the new readMessages.
    // (The adapter captures `sock` at connect time, so we need a fresh adapter.)
    const account = makeSelfChatAccount();
    account.accountId = "test-read-error";
    const adapter = createWhatsAppAdapter(account);
    const onMessage = mock(async (_msg: InboundChannelMessage) => {});
    adapter.onMessage = onMessage;

    await startAdapterAndConnect(adapter);

    const msg = makeInboundMessage({
      messageId: "rr-test-2",
      remoteJid: "15559998888@s.whatsapp.net",
    });
    emitMessagesUpsert([msg]);

    // Wait for the async handler to complete.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // readMessages was called (and threw), but the inbound handler still
    // delivered the message to onMessage.
    expect(mockReadMessages).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalled();

    console.warn = originalWarn;
    await adapter.stop();
  });

  test("calls readMessages for each message in a batch", async () => {
    // Reset to a non-throwing mock for this test.
    mockReadMessages = mock(async () => {});

    const account = makeSelfChatAccount();
    account.accountId = "test-read-batch";
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
