import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Module mocks ────────────────────────────────────────────────────
//
// We mock the WhatsApp runtime and session modules so the adapter can be
// instantiated without a real Baileys connection. The mock socket exposes
// `onWhatsApp` so we can control LID lookup responses in tests.

let mockOnWhatsApp: ReturnType<typeof mock> = mock(async () => []);
let mockSendMessage: ReturnType<typeof mock> = mock(async () => ({}));
let mockSendPresenceUpdate: ReturnType<typeof mock> = mock(async () => {});
let mockReadMessages: ReturnType<typeof mock> = mock(async () => {});
let connectionUpdateHandler:
  | ((update: Record<string, unknown>) => void)
  | null = null;

let messagesUpsertHandler: ((event: unknown) => void) | null = null;

let tempDir: string;

mock.module("@/channels/whatsapp/runtime", () => ({
  loadWhatsAppModule: async () => ({
    downloadContentFromMessage: () => undefined,
  }),
}));

mock.module("@/channels/whatsapp/session", () => ({
  getWhatsAppAuthDir: (accountId: string) => {
    void accountId;
    // Use the temp dir so LidDesk persistence works in isolation.
    return tempDir;
  },
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
      user: {
        id: "15551234567@s.whatsapp.net",
        lid: "mylid@lid",
      },
      readMessages: mockReadMessages,
      sendMessage: mockSendMessage,
      sendPresenceUpdate: mockSendPresenceUpdate,
      onWhatsApp: mockOnWhatsApp,
      groupMetadata: async () => ({ subject: "Test Group" }),
    };
    return { sock, release: () => {} };
  },
}));

// ── Import adapter AFTER mocks are registered ───────────────────────

const { createWhatsAppAdapter } = await import("@/channels/whatsapp/adapter");

// ── Helpers ─────────────────────────────────────────────────────────

function makeAccount() {
  return {
    channel: "whatsapp" as const,
    accountId: "test-bootstrap",
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

async function startAndConnect() {
  const adapter = createWhatsAppAdapter(makeAccount());
  await adapter.start();
  connectionUpdateHandler?.({ connection: "open" });
  return adapter;
}

// ── Tests ───────────────────────────────────────────────────────────

describe("tryBootstrapOutboundRoute", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "outbound-bootstrap-test-"));
    mockOnWhatsApp = mock(async () => []);
    mockSendMessage = mock(async () => ({ key: { id: "msg-out" } }));
    mockSendPresenceUpdate = mock(async () => {});
    mockReadMessages = mock(async () => {});
    connectionUpdateHandler = null;
    messagesUpsertHandler = null;
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test("resolves a phone number to a LID via mock onWhatsApp", async () => {
    mockOnWhatsApp = mock(async () => [
      {
        exists: true,
        jid: "15557654321@s.whatsapp.net",
        lid: "7654321@lid",
      },
    ]);

    const adapter = await startAndConnect();
    const result = await adapter.tryBootstrapOutboundRoute(
      "15557654321@s.whatsapp.net",
    );

    expect(result).toBe(true);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  test("returns false for numbers not on WhatsApp", async () => {
    mockOnWhatsApp = mock(async () => [{ exists: false }]);

    const adapter = await startAndConnect();
    const result = await adapter.tryBootstrapOutboundRoute(
      "15550000000@s.whatsapp.net",
    );

    expect(result).toBe(false);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(1);

    await adapter.stop();
  });

  test("returns true and persists mapping for valid numbers", async () => {
    mockOnWhatsApp = mock(async () => [
      {
        exists: true,
        jid: "15558887777@s.whatsapp.net",
        lid: "8887777@lid",
      },
    ]);

    const adapter = await startAndConnect();
    const result = await adapter.tryBootstrapOutboundRoute(
      "15558887777@s.whatsapp.net",
    );

    expect(result).toBe(true);

    // Verify the mapping is now usable — a sendMessage to the resolved
    // LID should resolve back to the phone JID.
    await adapter.sendMessage({
      channel: "whatsapp",
      chatId: "8887777@lid",
      text: "Hello after bootstrap",
    });

    const sendMessageCall = mockSendMessage.mock.calls[0];
    expect(sendMessageCall?.[0]).toBe("15558887777@s.whatsapp.net");

    await adapter.stop();
  });

  test("does not call onWhatsApp when mapping is already cached", async () => {
    mockOnWhatsApp = mock(async () => [
      {
        exists: true,
        jid: "15551112222@s.whatsapp.net",
        lid: "cached-lid@lid",
      },
    ]);

    const adapter = await startAndConnect();

    // First call resolves via onWhatsApp and caches the mapping.
    const first = await adapter.tryBootstrapOutboundRoute(
      "15551112222@s.whatsapp.net",
    );
    expect(first).toBe(true);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(1);

    // Second call should short-circuit via cache — onWhatsApp NOT called again.
    mockOnWhatsApp.mockClear();
    const second = await adapter.tryBootstrapOutboundRoute(
      "15551112222@s.whatsapp.net",
    );
    expect(second).toBe(true);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(0);

    await adapter.stop();
  });

  test("rate limit is respected — excess calls return false", async () => {
    // The LidDesk rate limit defaults to 10/min. We exhaust it by calling
    // with a number that returns exists:false (so no cache is written).
    mockOnWhatsApp = mock(async () => [{ exists: false }]);

    const adapter = await startAndConnect();

    // Make 10 calls (all miss, all return false — rate limit not yet hit).
    for (let i = 0; i < 10; i++) {
      const result = await adapter.tryBootstrapOutboundRoute(
        "15559990001@s.whatsapp.net",
      );
      expect(result).toBe(false);
    }
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(10);

    // 11th call — rate limited, should return false without calling onWhatsApp.
    mockOnWhatsApp.mockClear();
    const result = await adapter.tryBootstrapOutboundRoute(
      "15559990001@s.whatsapp.net",
    );
    expect(result).toBe(false);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(0);

    await adapter.stop();
  });

  test("returns false for non-phone chatIds (LID, group, broadcast)", async () => {
    const adapter = await startAndConnect();

    // LID JID — not a phone, no bootstrap needed.
    mockOnWhatsApp.mockClear();
    expect(await adapter.tryBootstrapOutboundRoute("1234567890@lid")).toBe(
      false,
    );
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(0);

    // Group JID — not a phone.
    expect(
      await adapter.tryBootstrapOutboundRoute("120363000000000000@g.us"),
    ).toBe(false);
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(0);

    // Broadcast JID.
    expect(await adapter.tryBootstrapOutboundRoute("status@broadcast")).toBe(
      false,
    );
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(0);

    await adapter.stop();
  });

  test("accepts raw phone digits (normalizes to JID)", async () => {
    mockOnWhatsApp = mock(async (phone: string) => [
      {
        exists: true,
        jid: phone,
        lid: "digits-lid@lid",
      },
    ]);

    const adapter = await startAndConnect();
    const result = await adapter.tryBootstrapOutboundRoute("15557776666");

    expect(result).toBe(true);
    // onWhatsApp should have been called with the normalized JID.
    expect(mockOnWhatsApp).toHaveBeenCalledTimes(1);
    const calledPhone = mockOnWhatsApp.mock.calls[0]?.[0];
    expect(calledPhone).toBe("15557776666@s.whatsapp.net");

    await adapter.stop();
  });

  test("returns false when onWhatsApp throws", async () => {
    mockOnWhatsApp = mock(async () => {
      throw new Error("network error");
    });

    const adapter = await startAndConnect();
    const result = await adapter.tryBootstrapOutboundRoute(
      "15550000001@s.whatsapp.net",
    );

    expect(result).toBe(false);

    await adapter.stop();
  });
});
