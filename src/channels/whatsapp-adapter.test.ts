import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
  type WhatsAppAdapterDependencies,
  type WhatsAppReconnectScheduler,
} from "@/channels/whatsapp/adapter";
import type { LidStore } from "@/channels/whatsapp/lid-store";
import {
  createWhatsAppSocket,
  getWhatsAppAuthDir,
} from "@/channels/whatsapp/session";
import {
  clearWhatsAppConnectionState,
  getWhatsAppConnectionState,
  setWhatsAppConnectionState,
} from "@/channels/whatsapp/state";

const activeHarnesses: Array<{
  accountId: string;
  adapter: { stop(): Promise<void> };
}> = [];

afterEach(async () => {
  for (const harness of activeHarnesses) {
    await harness.adapter.stop();
    clearWhatsAppConnectionState(harness.accountId);
  }
  activeHarnesses.length = 0;
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
    await adapter.stop();
  });
});

type SchedulerEntry = {
  callback: () => void;
  canceled: boolean;
  delayMs: number;
  dueAt: number;
  fired: boolean;
  unref: boolean;
};

type SocketResult = Awaited<
  ReturnType<NonNullable<WhatsAppAdapterDependencies["createSocket"]>>
>;

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createSessionRuntimeHarness() {
  const handlers = new Map<
    string,
    (payload?: unknown) => void | Promise<void>
  >();
  const sock = {
    ev: {
      on(event: string, handler: (payload?: unknown) => void | Promise<void>) {
        handlers.set(event, handler);
      },
    },
    user: { id: "15551234567@s.whatsapp.net", lid: "15551234567@lid" },
    ws: { close() {} },
  };
  const runtime = {
    makeWASocket: () => sock,
    useMultiFileAuthState: async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: async () => undefined,
    }),
    fetchLatestBaileysVersion: async () => ({ version: [2, 3000, 0] }),
    DisconnectReason: { loggedOut: 401 },
  };
  return { handlers, runtime };
}

function createTestScheduler() {
  const entries: SchedulerEntry[] = [];
  let nowMs = 0;
  const scheduler: WhatsAppReconnectScheduler = {
    now: () => nowMs,
    schedule(delayMs, callback, options) {
      const entry: SchedulerEntry = {
        callback,
        canceled: false,
        delayMs,
        dueAt: nowMs + delayMs,
        fired: false,
        unref: options?.unref === true,
      };
      entries.push(entry);
      return {
        cancel() {
          entry.canceled = true;
        },
      };
    },
  };

  function run(entry: SchedulerEntry): void {
    entry.fired = true;
    nowMs = entry.dueAt;
    entry.callback();
  }

  return {
    entries,
    scheduler,
    advanceToNext() {
      const next = entries
        .filter((entry) => !entry.canceled && !entry.fired)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!next) throw new Error("expected pending scheduler task");
      run(next);
    },
    advanceBy(delayMs: number) {
      const target = nowMs + delayMs;
      for (;;) {
        const next = entries
          .filter(
            (entry) => !entry.canceled && !entry.fired && entry.dueAt <= target,
          )
          .sort((left, right) => left.dueAt - right.dueAt)[0];
        if (!next) break;
        run(next);
      }
      nowMs = target;
    },
    pending() {
      return entries.filter((entry) => !entry.canceled && !entry.fired);
    },
    runCanceled() {
      for (const entry of entries.filter(
        (candidate) => candidate.canceled && !candidate.fired,
      )) {
        run(entry);
      }
    },
  };
}

function createReconnectHarness(
  accountId: string,
  options: {
    socketResults?: Array<Promise<SocketResult> | SocketResult | undefined>;
  } = {},
) {
  type ConnectionUpdate = (update: Record<string, unknown>) => void;
  const scheduler = createTestScheduler();
  const updates: ConnectionUpdate[] = [];
  let createSocketCalls = 0;
  let releaseCalls = 0;
  const emptyStore: LidStore = {
    resolve() {
      return null;
    },
    record() {
      return { status: "idempotent" };
    },
    flush() {},
  };
  function createDefaultSocketResult(): SocketResult {
    return {
      sock: {
        ev: { on: () => undefined },
        ws: { close: () => undefined },
        user: { id: "15551234567@s.whatsapp.net", lid: undefined },
      },
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => {
        releaseCalls += 1;
      },
    };
  }
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async ({ onConnectionUpdate }) => {
    createSocketCalls += 1;
    updates.push(onConnectionUpdate as ConnectionUpdate);
    const plannedResult = options.socketResults?.[createSocketCalls - 1];
    if (plannedResult) return await plannedResult;
    return createDefaultSocketResult();
  };
  const adapter = createWhatsAppAdapter(
    {
      channel: "whatsapp",
      accountId,
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      agentId: "agent-whatsapp",
      selfChatMode: false,
      groupMode: "disabled",
    },
    {
      createSocket,
      loadRuntimeModule: async () => ({}),
      lidStore: emptyStore,
      reconnectScheduler: scheduler.scheduler,
    },
  );
  activeHarnesses.push({ accountId, adapter });

  return {
    adapter,
    scheduler,
    get createSocketCalls() {
      return createSocketCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    close(index = updates.length - 1, message = "timed out") {
      updates[index]?.({
        connection: "close",
        lastDisconnect: { error: { message } },
      });
    },
    open(index = updates.length - 1) {
      updates[index]?.({ connection: "open" });
    },
  };
}

async function flushReconnectMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("WhatsApp reconnect circuit breaker", () => {
  test("counts duplicate closes from one socket generation once", async () => {
    const harness = createReconnectHarness("reconnect-duplicate-close");
    await harness.adapter.start();

    for (let index = 0; index < 6; index += 1) {
      harness.close();
    }
    harness.open(0);
    expect(harness.scheduler.pending()).toHaveLength(1);
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(2000);
    expect(harness.scheduler.pending()[0]?.unref).toBe(true);

    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);
    expect(harness.adapter.isRunning()).toBe(true);
  });

  test("ignores stale closes from older socket generations", async () => {
    const harness = createReconnectHarness("reconnect-stale-generation");
    await harness.adapter.start();

    harness.close(0);
    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);

    harness.close(0, "late stale close");
    expect(harness.scheduler.pending()).toHaveLength(0);

    harness.close(1);
    expect(harness.scheduler.pending()).toHaveLength(1);
  });

  test("ignores a stale close from a stopped socket after a newer start", async () => {
    const accountId = "reconnect-stale-after-restart";
    const harness = createReconnectHarness(accountId);
    await harness.adapter.start();
    await harness.adapter.stop();
    await harness.adapter.start();
    const releaseCallsAfterRestart = harness.releaseCalls;
    setWhatsAppConnectionState(accountId, {
      status: "connected",
      phoneJid: "current@s.whatsapp.net",
    });
    const currentState = getWhatsAppConnectionState(accountId);

    harness.close(0, "late generation one close");

    expect(harness.createSocketCalls).toBe(2);
    expect(harness.releaseCalls).toBe(releaseCallsAfterRestart);
    expect(harness.scheduler.pending()).toHaveLength(0);
    expect(getWhatsAppConnectionState(accountId)).toEqual(currentState);
  });

  test("trips after six distinct unstable generations despite brief opens", async () => {
    const accountId = "reconnect-six-generations";
    const harness = createReconnectHarness(accountId);
    await harness.adapter.start();

    for (let index = 0; index < 6; index += 1) {
      harness.open();
      harness.close(index, `unstable ${index}`);
      if (index < 5) {
        harness.scheduler.advanceToNext();
        await flushReconnectMicrotasks();
      }
    }

    expect(harness.adapter.isRunning()).toBe(false);
    expect(harness.scheduler.pending()).toHaveLength(0);
    expect(getWhatsAppConnectionState(accountId).lastError).toContain(
      "disconnected 6 times in 60s",
    );
    expect(getWhatsAppConnectionState(accountId).lastError).toContain(
      "Another client may be competing",
    );
    expect(harness.releaseCalls).toBe(6);
  });

  test("resets history and backoff only after sixty seconds of stable uptime", async () => {
    const harness = createReconnectHarness("reconnect-stable-reset");
    await harness.adapter.start();

    harness.close();
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(2000);
    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    harness.open();
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(60_000);
    expect(harness.scheduler.pending()[0]?.unref).toBe(true);
    harness.scheduler.advanceBy(59_999);
    harness.close();
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(4000);
    expect(harness.scheduler.pending()[0]?.unref).toBe(true);

    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    harness.open();
    harness.scheduler.advanceBy(60_000);
    harness.close();
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(2000);
  });

  test("stop cancels reconnect and stability tasks and stale callbacks cannot reconnect", async () => {
    const harness = createReconnectHarness("reconnect-stop-cancels");
    await harness.adapter.start();
    harness.open();
    const stableTask = harness.scheduler.pending()[0];

    await harness.adapter.stop();
    expect(stableTask?.canceled).toBe(true);
    harness.scheduler.runCanceled();
    expect(harness.createSocketCalls).toBe(1);

    await harness.adapter.start();
    harness.close();
    const reconnectTask = harness.scheduler.pending()[0];
    await harness.adapter.stop();
    expect(reconnectTask?.canceled).toBe(true);
    harness.scheduler.runCanceled();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);
  });

  test("stale reconnect rejection after stop does not write error state", async () => {
    const accountId = "reconnect-reject-after-stop";
    const reconnectAttempt = createDeferred<SocketResult>();
    const harness = createReconnectHarness(accountId, {
      socketResults: [undefined, reconnectAttempt.promise],
    });
    await harness.adapter.start();
    harness.close();
    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);

    await harness.adapter.stop();
    const stoppedState = getWhatsAppConnectionState(accountId);
    reconnectAttempt.reject(new Error("late stale reconnect failure"));
    await flushReconnectMicrotasks();

    expect(getWhatsAppConnectionState(accountId)).toEqual(stoppedState);
    expect(harness.scheduler.pending()).toHaveLength(0);
  });

  test("stale reconnect rejection after newer start does not overwrite current state", async () => {
    const accountId = "reconnect-reject-after-restart";
    const reconnectAttempt = createDeferred<SocketResult>();
    const harness = createReconnectHarness(accountId, {
      socketResults: [undefined, reconnectAttempt.promise],
    });
    await harness.adapter.start();
    harness.close();
    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);

    await harness.adapter.stop();
    await harness.adapter.start();
    setWhatsAppConnectionState(accountId, {
      status: "connected",
      phoneJid: "current@s.whatsapp.net",
    });
    const currentState = getWhatsAppConnectionState(accountId);
    reconnectAttempt.reject(new Error("late stale reconnect failure"));
    await flushReconnectMicrotasks();

    expect(harness.createSocketCalls).toBe(3);
    expect(getWhatsAppConnectionState(accountId)).toEqual(currentState);
    expect(harness.scheduler.pending()).toHaveLength(0);
  });

  test("preserves conflict error through real session close ordering", async () => {
    const accountId = `reconnect-session-conflict-${Date.now()}-${Math.random()}`;
    const scheduler = createTestScheduler();
    const session = createSessionRuntimeHarness();
    const adapter = createWhatsAppAdapter(
      {
        channel: "whatsapp",
        accountId,
        enabled: true,
        dmPolicy: "pairing",
        allowedUsers: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        agentId: "agent-whatsapp",
        selfChatMode: false,
        groupMode: "disabled",
      },
      {
        createSocket: async (params) =>
          createWhatsAppSocket({
            ...params,
            printQr: false,
            loadRuntimeModule: async () => session.runtime,
          }),
        loadRuntimeModule: async () => ({}),
        reconnectScheduler: scheduler.scheduler,
      },
    );

    try {
      await adapter.start();
      await session.handlers.get("connection.update")?.({
        connection: "close",
        lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
      });

      expect(adapter.isRunning()).toBe(false);
      expect(scheduler.pending()).toHaveLength(0);
      expect(getWhatsAppConnectionState(accountId)).toMatchObject({
        status: "error",
        lastError:
          "Stream Errored (conflict). Another WhatsApp client is using this linked-device session; not reconnecting automatically.",
      });
    } finally {
      await adapter.stop();
      clearWhatsAppConnectionState(accountId);
      rmSync(getWhatsAppAuthDir(accountId), { recursive: true, force: true });
    }
  });

  test("explicit conflict stops without another reconnect and preserves conflict error", async () => {
    const accountId = "reconnect-explicit-conflict";
    const harness = createReconnectHarness(accountId);
    await harness.adapter.start();
    harness.close();
    const reconnectTask = harness.scheduler.pending()[0];

    harness.close(undefined, "Stream Errored (conflict)");

    expect(harness.adapter.isRunning()).toBe(false);
    expect(reconnectTask?.canceled).toBe(true);
    expect(harness.scheduler.pending()).toHaveLength(0);
    harness.scheduler.runCanceled();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(1);
    expect(getWhatsAppConnectionState(accountId).lastError).toContain(
      "Another WhatsApp client is using this linked-device session",
    );
  });

  test("explicit start after circuit-breaker stop begins with clean history", async () => {
    const harness = createReconnectHarness("reconnect-explicit-start");
    await harness.adapter.start();
    for (let index = 0; index < 6; index += 1) {
      harness.close();
      if (index < 5) {
        harness.scheduler.advanceToNext();
        await flushReconnectMicrotasks();
      }
    }
    expect(harness.adapter.isRunning()).toBe(false);

    await harness.adapter.start();
    harness.close();
    expect(harness.scheduler.pending()[0]?.delayMs).toBe(2000);
    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    for (let index = 0; index < 4; index += 1) {
      harness.close();
      harness.scheduler.advanceToNext();
      await flushReconnectMicrotasks();
    }
    expect(harness.adapter.isRunning()).toBe(true);
  });
});
