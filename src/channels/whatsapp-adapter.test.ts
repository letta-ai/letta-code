import { afterEach, describe, expect, test } from "bun:test";
import {
  createWhatsAppAdapter,
  isWhatsAppConflictDisconnect,
  type WhatsAppAdapterDependencies,
  type WhatsAppReconnectScheduler,
} from "@/channels/whatsapp/adapter";
import type { LidStore } from "@/channels/whatsapp/lid-store";
import {
  clearWhatsAppConnectionState,
  getWhatsAppConnectionState,
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

function createReconnectHarness(accountId: string) {
  type ConnectionUpdate = (update: Record<string, unknown>) => void;
  const scheduler = createTestScheduler();
  const updates: ConnectionUpdate[] = [];
  let createSocketCalls = 0;
  let releaseCalls = 0;
  const presenceCalls: Array<{
    socket: number;
    presence: string;
    jid?: string;
  }> = [];
  const sentPayloads: Array<{
    socket: number;
    payload: Record<string, unknown>;
  }> = [];
  const emptyStore = {
    resolve: () => null,
    record: () => ({ status: "idempotent" as const }),
    flush: () => undefined,
  } as LidStore;
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async ({ onConnectionUpdate }) => {
    createSocketCalls += 1;
    updates.push(onConnectionUpdate as ConnectionUpdate);
    return {
      sock: {
        ev: { on: () => undefined },
        ws: { close: () => undefined },
        user: { id: "15551234567@s.whatsapp.net", lid: undefined },
        async sendPresenceUpdate(presence: string, jid?: string) {
          presenceCalls.push({ socket: createSocketCalls, presence, jid });
        },
        async sendMessage(_jid: string, payload: Record<string, unknown>) {
          sentPayloads.push({ socket: createSocketCalls, payload });
          return { key: { id: `sent-${createSocketCalls}` } };
        },
      },
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => {
        releaseCalls += 1;
      },
    };
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
      waitingBehavior: "typing_indicator",
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
    presenceCalls,
    sentPayloads,
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

    harness.close();
    harness.close();
    expect(harness.scheduler.pending()).toHaveLength(1);
    expect(harness.scheduler.pending()[0]?.unref).toBe(false);

    harness.scheduler.advanceToNext();
    await flushReconnectMicrotasks();
    expect(harness.createSocketCalls).toBe(2);
    expect(harness.adapter.isRunning()).toBe(true);
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

  test("clears managed typing on rapid-loop trip before a clean restart", async () => {
    const harness = createReconnectHarness("reconnect-typing-clear");
    await harness.adapter.start();
    await harness.adapter.handleTurnLifecycleEvent?.({
      type: "processing",
      batchId: "typing-batch",
      sources: [
        {
          channel: "whatsapp",
          accountId: "reconnect-typing-clear",
          chatId: "15551234567@s.whatsapp.net",
          messageId: "typing-message",
          agentId: "agent-whatsapp",
          conversationId: "typing-conversation",
        },
      ],
    });
    expect(harness.presenceCalls).toEqual([
      {
        socket: 1,
        presence: "composing",
        jid: "15551234567@s.whatsapp.net",
      },
    ]);

    for (let index = 0; index < 6; index += 1) {
      harness.open();
      harness.close(index, `unstable ${index}`);
      if (index < 5) {
        harness.scheduler.advanceToNext();
        await flushReconnectMicrotasks();
      }
    }

    expect(harness.adapter.isRunning()).toBe(false);
    expect(harness.presenceCalls).toEqual([
      {
        socket: 1,
        presence: "composing",
        jid: "15551234567@s.whatsapp.net",
      },
    ]);

    await harness.adapter.start();
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: "reconnect-typing-clear",
      chatId: "15551234567@s.whatsapp.net",
      text: "fresh message",
    });
    expect(harness.presenceCalls).toEqual([
      {
        socket: 1,
        presence: "composing",
        jid: "15551234567@s.whatsapp.net",
      },
      {
        socket: 7,
        presence: "composing",
        jid: "15551234567@s.whatsapp.net",
      },
    ]);
    expect(harness.sentPayloads).toEqual([
      { socket: 7, payload: { text: "fresh message" } },
    ]);
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
    expect(harness.scheduler.pending()[0]?.unref).toBe(false);

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
    expect(harness.adapter.isRunning()).toBe(true);
    for (let index = 0; index < 5; index += 1) {
      harness.close();
      harness.scheduler.advanceToNext();
      await flushReconnectMicrotasks();
    }
    expect(harness.adapter.isRunning()).toBe(true);
  });
});
