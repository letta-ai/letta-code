import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
} from "@/channels/whatsapp/adapter";
import {
  clearWhatsAppConnectionState,
  getWhatsAppConnectionState,
} from "@/channels/whatsapp/state";

afterEach(() => {
  mock.restore();
});

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

describe("WhatsApp reconnect guardrail", () => {
  test("stops reconnecting and sets error state after rapid disconnect loop", async () => {
    clearWhatsAppConnectionState("guardrail-test");

    let capturedUpdate:
      | ((update: Record<string, unknown>) => void)
      | null = null;

    mock.module("@/channels/whatsapp/session", () => ({
      createWhatsAppSocket: (params: {
        onConnectionUpdate?: (update: Record<string, unknown>) => void;
      }) => {
        capturedUpdate = params.onConnectionUpdate ?? null;
        return Promise.resolve({
          sock: {
            ev: { on: () => {} },
            ws: { close: () => {} },
            user: { id: "12345@s.whatsapp.net", lid: null },
          },
          saveCreds: async () => {},
          DisconnectReason: {},
          release: () => {},
        });
      },
      getWhatsAppAuthDir: () => "/tmp/test-auth",
    }));

    mock.module("@/channels/whatsapp/runtime", () => ({
      loadWhatsAppModule: async () => ({ downloadContentFromMessage: () => {} }),
      loadQrCodeTerminalModule: async () => ({ default: { generate: () => {} } }),
      isWhatsAppRuntimeInstalled: () => true,
      installWhatsAppRuntime: async () => {},
      ensureWhatsAppRuntimeInstalled: async () => true,
    }));

    const adapter = createWhatsAppAdapter({
      channel: "whatsapp",
      accountId: "guardrail-test",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
    });

    await adapter.start();
    expect(capturedUpdate).not.toBeNull();

    const fireClose = () =>
      capturedUpdate!({
        connection: "close",
        lastDisconnect: { error: { message: "timed out" } },
      });

    // Fire 5 close events — these should schedule reconnects but not trip
    // the guardrail (limit is 5, guardrail fires when count exceeds 5).
    for (let i = 0; i < 5; i++) {
      fireClose();
    }
    expect(adapter.isRunning()).toBe(true);

    // 6th rapid disconnect exceeds the limit → guardrail trips.
    fireClose();

    expect(adapter.isRunning()).toBe(false);

    const state = getWhatsAppConnectionState("guardrail-test");
    expect(state.status).toBe("error");
    expect(state.lastError).toContain("reconnect loop");
    expect(state.lastError).toContain("Another client may be competing");

    clearWhatsAppConnectionState("guardrail-test");
  });
});
