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
  const STABLE_OPEN_RESET_MS = 60_000;

  type CapturedTimer = {
    callback: () => void;
    cleared: boolean;
    delay?: number;
    dueAt: number;
    fired: boolean;
    unref: () => void;
  };

  function captureTimers() {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const originalDateNow = Date.now;
    const timers: CapturedTimer[] = [];
    let now = 0;

    function nextPendingTimer(target: number): CapturedTimer | undefined {
      let next: CapturedTimer | undefined;
      for (const timer of timers) {
        if (timer.cleared || timer.fired || timer.dueAt > target) continue;
        if (!next || timer.dueAt < next.dueAt) next = timer;
      }
      return next;
    }

    function runTimer(timer: CapturedTimer): void {
      timer.fired = true;
      now = timer.dueAt;
      timer.callback();
    }

    Date.now = () => now;

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
        dueAt: now + Math.max(0, Number(delay ?? 0)),
        fired: false,
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
      pendingTimers(delay?: number) {
        return timers.filter(
          (timer) =>
            !timer.cleared &&
            !timer.fired &&
            (delay === undefined || timer.delay === delay),
        );
      },
      advanceBy(ms: number) {
        const target = now + ms;
        for (;;) {
          const timer = nextPendingTimer(target);
          if (!timer) break;
          runTimer(timer);
        }
        now = target;
      },
      advanceToNextTimer() {
        const timer = nextPendingTimer(Number.POSITIVE_INFINITY);
        if (!timer) throw new Error("expected pending timer");
        runTimer(timer);
      },
      runUnclearedTimers() {
        for (;;) {
          const timer = nextPendingTimer(Number.POSITIVE_INFINITY);
          if (!timer) break;
          runTimer(timer);
        }
      },
      restore() {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
        Date.now = originalDateNow;
      },
    };
  }

  function requirePendingTimer(
    timers: ReturnType<typeof captureTimers>,
    delay?: number,
  ): CapturedTimer {
    const timer = timers.pendingTimers(delay)[0];
    if (!timer) {
      throw new Error(
        `expected pending timer${delay === undefined ? "" : ` with delay ${delay}`}`,
      );
    }
    return timer;
  }

  function mockWhatsAppSession() {
    type ConnectionUpdate = (update: Record<string, unknown>) => void;

    const capturedUpdates: Array<ConnectionUpdate | null> = [];
    let createSocketCalls = 0;
    let releaseCalls = 0;

    function latestUpdate(): ConnectionUpdate | null {
      return capturedUpdates[capturedUpdates.length - 1] ?? null;
    }

    mock.module("@/channels/whatsapp/session", () => ({
      createWhatsAppSocket: (params: {
        onConnectionUpdate?: (update: Record<string, unknown>) => void;
      }) => {
        createSocketCalls += 1;
        capturedUpdates.push(params.onConnectionUpdate ?? null);
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
      fireOpen(generationIndex = capturedUpdates.length - 1) {
        capturedUpdates[generationIndex]?.({ connection: "open" });
      },
      fireClose(
        message = "timed out",
        generationIndex = capturedUpdates.length - 1,
      ) {
        capturedUpdates[generationIndex]?.({
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
        return latestUpdate();
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

  async function advanceToReconnectedSocket(
    timers: ReturnType<typeof captureTimers>,
  ) {
    timers.advanceToNextTimer();
    await flushReconnectMicrotasks();
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
      const reconnectTimer = requirePendingTimer(timers);
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

  test("counts rapid disconnects across distinct socket generations", async () => {
    const accountId = "guardrail-generations-test";
    clearWhatsAppConnectionState(accountId);
    const timers = captureTimers();

    try {
      const session = mockWhatsAppSession();
      const adapter = createGuardrailAdapter(accountId);

      await adapter.start();
      expect(session.createSocketCalls).toBe(1);

      for (let i = 0; i < 5; i++) {
        session.fireOpen();
        const stableTimer = requirePendingTimer(timers, STABLE_OPEN_RESET_MS);
        session.fireClose(`loop ${i}`);
        expect(stableTimer.cleared).toBe(true);
        expect(adapter.isRunning()).toBe(true);

        await advanceToReconnectedSocket(timers);
        expect(session.createSocketCalls).toBe(i + 2);
      }

      session.fireOpen();
      const terminalStableTimer = requirePendingTimer(
        timers,
        STABLE_OPEN_RESET_MS,
      );
      session.fireClose("loop terminal");

      expect(adapter.isRunning()).toBe(false);
      expect(terminalStableTimer.cleared).toBe(true);
      expect(timers.pendingTimers()).toHaveLength(0);

      timers.runUnclearedTimers();
      await flushReconnectMicrotasks();
      expect(session.createSocketCalls).toBe(6);
      expect(terminalStableTimer.fired).toBe(false);

      const state = getWhatsAppConnectionState(accountId);
      expect(state.status).toBe("error");
      expect(state.lastError).toContain("disconnected 6 times in 60s");
    } finally {
      timers.restore();
      clearWhatsAppConnectionState(accountId);
    }
  });

  test("stable open resets disconnect window and reconnect attempts", async () => {
    const accountId = "guardrail-stable-reset-test";
    clearWhatsAppConnectionState(accountId);
    const timers = captureTimers();

    try {
      const session = mockWhatsAppSession();
      const adapter = createGuardrailAdapter(accountId);

      await adapter.start();

      for (let i = 0; i < 5; i++) {
        session.fireOpen();
        session.fireClose(`loop ${i}`);
        await advanceToReconnectedSocket(timers);
      }
      expect(session.createSocketCalls).toBe(6);

      session.fireOpen();
      const stableTimer = requirePendingTimer(timers, STABLE_OPEN_RESET_MS);
      timers.advanceBy(STABLE_OPEN_RESET_MS);
      expect(stableTimer.fired).toBe(true);

      session.fireClose("post-stable close");

      expect(adapter.isRunning()).toBe(true);
      expect(requirePendingTimer(timers).delay).toBe(2000);
    } finally {
      timers.restore();
      clearWhatsAppConnectionState(accountId);
    }
  });

  test("stop cancels pending reconnect and stability timers", async () => {
    const accountId = "guardrail-stop-test";
    clearWhatsAppConnectionState(accountId);
    const timers = captureTimers();

    try {
      const session = mockWhatsAppSession();
      const adapter = createGuardrailAdapter(accountId);

      await adapter.start();
      expect(session.createSocketCalls).toBe(1);

      session.fireOpen();
      const stableTimer = requirePendingTimer(timers, STABLE_OPEN_RESET_MS);
      session.fireClose();
      expect(stableTimer.cleared).toBe(true);
      const reconnectTimer = requirePendingTimer(timers);
      expect(reconnectTimer.cleared).toBe(false);

      await adapter.stop();

      expect(adapter.isRunning()).toBe(false);
      expect(reconnectTimer.cleared).toBe(true);

      timers.runUnclearedTimers();
      await flushReconnectMicrotasks();
      expect(session.createSocketCalls).toBe(1);
      expect(stableTimer.fired).toBe(false);
      expect(reconnectTimer.fired).toBe(false);
      expect(session.releaseCalls).toBe(1);
    } finally {
      timers.restore();
      clearWhatsAppConnectionState(accountId);
    }
  });
});
