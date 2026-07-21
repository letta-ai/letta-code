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
  type CapturedTimer = {
    callback: () => void;
    cleared: boolean;
    delay?: number;
    unref: () => void;
  };

  function captureTimers() {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers: CapturedTimer[] = [];

    globalThis.setTimeout = ((
      handler: unknown,
      delay?: number,
      ...args: unknown[]
    ) => {
      const timer: CapturedTimer = {
        callback: () => {
          if (typeof handler === "function") {
            (handler as (...handlerArgs: unknown[]) => void)(...args);
          }
        },
        cleared: false,
        delay,
        unref: () => {},
      };
      timers.push(timer);
      return timer;
    }) as unknown as typeof setTimeout;

    globalThis.clearTimeout = ((timer?: ReturnType<typeof setTimeout>) => {
      const captured = timer as unknown as CapturedTimer | undefined;
      if (captured && timers.includes(captured)) {
        captured.cleared = true;
      }
    }) as typeof clearTimeout;

    return {
      timers,
      runUnclearedTimers() {
        for (const timer of timers) {
          if (!timer.cleared) {
            timer.callback();
          }
        }
      },
      restore() {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      },
    };
  }

  function requireCapturedTimer(timers: CapturedTimer[]): CapturedTimer {
    const timer = timers[0];
    if (!timer) {
      throw new Error("expected reconnect timer");
    }
    return timer;
  }

  function mockWhatsAppSession() {
    let capturedUpdate: ((update: Record<string, unknown>) => void) | null =
      null;
    let createSocketCalls = 0;
    let releaseCalls = 0;

    mock.module("@/channels/whatsapp/session", () => ({
      createWhatsAppSocket: (params: {
        onConnectionUpdate?: (update: Record<string, unknown>) => void;
      }) => {
        createSocketCalls += 1;
        capturedUpdate = params.onConnectionUpdate ?? null;
        return Promise.resolve({
          sock: {
            ev: { on: () => {} },
            ws: { close: () => {} },
            user: { id: "12345@s.whatsapp.net", lid: null },
          },
          saveCreds: async () => {},
          DisconnectReason: {},
          release: () => {
            releaseCalls += 1;
          },
        });
      },
      getWhatsAppAuthDir: () => "/tmp/test-auth",
    }));

    mock.module("@/channels/whatsapp/runtime", () => ({
      loadWhatsAppModule: async () => ({
        downloadContentFromMessage: () => {},
      }),
      loadQrCodeTerminalModule: async () => ({
        default: { generate: () => {} },
      }),
      isWhatsAppRuntimeInstalled: () => true,
      installWhatsAppRuntime: async () => {},
      ensureWhatsAppRuntimeInstalled: async () => true,
    }));

    return {
      fireClose(message = "timed out") {
        capturedUpdate?.({
          connection: "close",
          lastDisconnect: { error: { message } },
        });
      },
      get createSocketCalls() {
        return createSocketCalls;
      },
      get releaseCalls() {
        return releaseCalls;
      },
      get capturedUpdate() {
        return capturedUpdate;
      },
    };
  }

  function createGuardrailAdapter(accountId: string) {
    return createWhatsAppAdapter({
      channel: "whatsapp",
      accountId,
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: true,
      groupMode: "disabled",
    });
  }

  async function flushReconnectMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  test("clears pending reconnect timer when rapid disconnect guardrail trips", async () => {
    const accountId = "guardrail-test";
    clearWhatsAppConnectionState(accountId);
    const timers = captureTimers();

    try {
      const session = mockWhatsAppSession();
      const adapter = createGuardrailAdapter(accountId);

      await adapter.start();
      expect(session.capturedUpdate).not.toBeNull();
      expect(session.createSocketCalls).toBe(1);

      // Fire 5 close events — these should schedule reconnects but not trip
      // the guardrail (limit is 5, guardrail fires when count exceeds 5).
      for (let i = 0; i < 5; i++) {
        session.fireClose();
      }
      expect(adapter.isRunning()).toBe(true);
      expect(timers.timers).toHaveLength(1);
      const reconnectTimer = requireCapturedTimer(timers.timers);
      expect(reconnectTimer.cleared).toBe(false);

      // 6th rapid disconnect exceeds the limit → guardrail trips and owns
      // cancellation of the previously scheduled reconnect timer.
      session.fireClose();

      expect(adapter.isRunning()).toBe(false);
      expect(reconnectTimer.cleared).toBe(true);

      timers.runUnclearedTimers();
      await flushReconnectMicrotasks();
      expect(session.createSocketCalls).toBe(1);

      const state = getWhatsAppConnectionState(accountId);
      expect(state.status).toBe("error");
      expect(state.lastError).toContain("reconnect loop");
      expect(state.lastError).toContain("Another client may be competing");
      expect(session.releaseCalls).toBe(1);
    } finally {
      timers.restore();
      clearWhatsAppConnectionState(accountId);
    }
  });

  test("stop cancels its pending reconnect timer and prevents stale reconnects", async () => {
    const accountId = "guardrail-stop-test";
    clearWhatsAppConnectionState(accountId);
    const timers = captureTimers();

    try {
      const session = mockWhatsAppSession();
      const adapter = createGuardrailAdapter(accountId);

      await adapter.start();
      expect(session.createSocketCalls).toBe(1);

      session.fireClose();
      expect(timers.timers).toHaveLength(1);
      const reconnectTimer = requireCapturedTimer(timers.timers);
      expect(reconnectTimer.cleared).toBe(false);

      await adapter.stop();

      expect(adapter.isRunning()).toBe(false);
      expect(reconnectTimer.cleared).toBe(true);

      timers.runUnclearedTimers();
      await flushReconnectMicrotasks();
      expect(session.createSocketCalls).toBe(1);
      expect(session.releaseCalls).toBe(1);
    } finally {
      timers.restore();
      clearWhatsAppConnectionState(accountId);
    }
  });
});
