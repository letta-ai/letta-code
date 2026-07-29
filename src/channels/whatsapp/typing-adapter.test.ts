import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ChannelAdapter,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
} from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "./adapter";
import { createLidStore } from "./lid-store";

const account = {
  channel: "whatsapp" as const,
  accountId: "typing-adapter",
  displayName: "WhatsApp",
  enabled: true,
  dmPolicy: "pairing" as const,
  allowedUsers: [],
  agentId: "agent-1",
  selfChatMode: false,
  groupMode: "open" as const,
  waitingBehavior: "typing_indicator" as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function source(overrides: Partial<ChannelTurnSource> = {}): ChannelTurnSource {
  return {
    channel: "whatsapp",
    accountId: account.accountId,
    chatId: "15550000001@s.whatsapp.net",
    messageId: "message-1",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conversation-1",
    ...overrides,
  };
}

function lifecycle(
  type: ChannelTurnLifecycleEvent["type"],
  overrides: Record<string, unknown> = {},
): ChannelTurnLifecycleEvent {
  if (type === "queued") {
    return {
      type,
      source: source(),
      ...overrides,
    } as ChannelTurnLifecycleEvent;
  }
  return {
    type,
    batchId: "batch-1",
    sources: [source()],
    ...(type === "finished"
      ? { outcome: "completed" as const, stopReason: "end_turn" as const }
      : {}),
    ...overrides,
  } as ChannelTurnLifecycleEvent;
}

type PresenceCall = { jid?: string; presence: string };

const temporaryDirectories: string[] = [];
const trackedAdapters: ChannelAdapter[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "whatsapp-typing-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function presenceNames(harness: { presence: PresenceCall[] }): string[] {
  return harness.presence.map((call) => call.presence);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

afterEach(async () => {
  try {
    for (const adapter of trackedAdapters) {
      await adapter.stop().catch(() => undefined);
    }
  } finally {
    trackedAdapters.length = 0;
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    temporaryDirectories.length = 0;
  }
});

function makeHarness(
  directory: string,
  options: {
    sendPresence?: (presence: string, jid?: string) => Promise<void> | void;
    waitingBehavior?: "off" | "typing_indicator";
    inboundDebounceMs?: number;
    lidMapping?: { lidJid: string; phoneJid: string };
  } = {},
) {
  const presence: PresenceCall[] = [];
  let connectionUpdate: ((update: Record<string, unknown>) => void) | undefined;
  let socketClosed = false;
  let upsertHandler: ((payload: unknown) => unknown) | undefined;
  const events: string[] = [];
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => unknown) {
        if (event === "messages.upsert") upsertHandler = handler;
      },
    },
    ws: {
      close() {
        socketClosed = true;
        events.push("socket-close");
      },
    },
    async sendMessage(_jid: string, _payload: Record<string, unknown>) {
      return { key: { id: "sent" } };
    },
    sendPresenceUpdate(presenceName: string, jid?: string) {
      presence.push({ jid, presence: presenceName });
      events.push(`presence:${presenceName}`);
      return options.sendPresence?.(presenceName, jid);
    },
  };
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async (socketOptions) => {
    connectionUpdate = socketOptions.onConnectionUpdate as unknown as (
      update: Record<string, unknown>,
    ) => void;
    return {
      sock: socket,
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => undefined,
    };
  };
  const lidStore = createLidStore(join(directory, "lid-mappings.json"));
  if (options.lidMapping) {
    lidStore.record(options.lidMapping.lidJid, options.lidMapping.phoneJid);
  }
  const adapter = createWhatsAppAdapter(
    {
      ...account,
      waitingBehavior: options.waitingBehavior ?? account.waitingBehavior,
      inboundDebounceMs: options.inboundDebounceMs,
    },
    {
      createSocket,
      loadRuntimeModule: async () => ({}),
      lidStore,
    },
  );
  adapter.onMessage = async () => {
    events.push("inbound-delivered");
  };
  trackedAdapters.push(adapter);
  return {
    adapter,
    presence,
    events,
    get socketClosed() {
      return socketClosed;
    },
    emitConnection(update: Record<string, unknown>) {
      connectionUpdate?.(update);
    },
    async emitUpsert(messages: Record<string, unknown>[]) {
      await upsertHandler?.({ type: "notify", messages });
    },
  };
}

describe("WhatsApp adapter typing lifecycle", () => {
  test("queued is inert and processing-to-finished composes then pauses", async () => {
    const harness = makeHarness(temporaryDirectory());
    await harness.adapter.start();
    const turn = source();
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("queued", { source: turn }),
    );
    expect(presenceNames(harness)).toEqual([]);

    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    expect(presenceNames(harness)).toEqual(["composing"]);
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("finished", { sources: [turn] }),
    );
    expect(presenceNames(harness)).toEqual(["composing", "paused"]);
  });

  test("off mode stays inert while normal sends preserve one-shot composing", async () => {
    const harness = makeHarness(temporaryDirectory(), {
      waitingBehavior: "off",
    });
    await harness.adapter.start();
    await harness.adapter.handleTurnLifecycleEvent?.(lifecycle("processing"));
    expect(presenceNames(harness)).toEqual([]);
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: source().chatId,
      text: "hello",
    });
    expect(presenceNames(harness)).toEqual(["composing"]);
  });

  test("normal send, reaction, and direct reply clear managed typing", async () => {
    const harness = makeHarness(temporaryDirectory());
    await harness.adapter.start();
    const turn = source();
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: turn.chatId,
      text: "hello",
    });
    expect(presenceNames(harness)).toEqual(["composing", "paused"]);

    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: turn.chatId,
      text: "",
      reaction: "👍",
      targetMessageId: "target",
    });
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    await harness.adapter.sendDirectReply(turn.chatId, "reply");
    expect(
      harness.presence.filter((call) => call.presence === "paused"),
    ).toHaveLength(3);
    expect(
      harness.presence.filter((call) => call.presence === "composing"),
    ).toHaveLength(3);
  });

  test("routes presence through canonical LID mappings", async () => {
    const harness = makeHarness(temporaryDirectory(), {
      lidMapping: {
        lidJid: "123456@lid",
        phoneJid: "15550000001@s.whatsapp.net",
      },
    });
    await harness.adapter.start();
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", {
        sources: [source({ chatId: "123456@lid" })],
      }),
    );
    expect(harness.presence[0]).toEqual({
      jid: "15550000001@s.whatsapp.net",
      presence: "composing",
    });
  });

  test("transient reconnect retains typing and conflict cancels without pause", async () => {
    const harness = makeHarness(temporaryDirectory());
    await harness.adapter.start();
    const turn = source();
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    harness.emitConnection({
      connection: "close",
      lastDisconnect: { error: { message: "timed out" } },
    });
    await wait(2100);
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("finished", { sources: [turn] }),
    );
    expect(presenceNames(harness)).toEqual(["composing", "paused"]);
    expect(harness.adapter.isRunning?.()).toBe(true);
    await harness.adapter.stop();

    const second = makeHarness(temporaryDirectory());
    await second.adapter.start();
    await second.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    second.emitConnection({
      connection: "close",
      lastDisconnect: { error: { message: "Stream Errored (conflict)" } },
    });
    expect(presenceNames(second)).toEqual(["composing"]);
    expect(second.adapter.isRunning?.()).toBe(false);
  });

  test("flushes debounce and pauses typing before closing the socket", async () => {
    const harness = makeHarness(temporaryDirectory(), {
      inboundDebounceMs: 10_000,
    });
    await harness.adapter.start();
    const turn = source();
    await harness.adapter.handleTurnLifecycleEvent?.(
      lifecycle("processing", { sources: [turn] }),
    );
    await harness.emitUpsert([
      {
        key: {
          remoteJid: turn.chatId,
          id: "pending-before-stop",
        },
        message: { conversation: "pending" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    expect(harness.events).toEqual(["presence:composing"]);
    await harness.adapter.stop?.();
    expect(harness.events).toEqual([
      "presence:composing",
      "inbound-delivered",
      "presence:paused",
      "socket-close",
    ]);
  });

  test("stop awaits delayed paused presence before socket close", async () => {
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = makeHarness(temporaryDirectory(), {
      sendPresence: (presenceName) =>
        presenceName === "paused" ? paused : undefined,
    });
    await harness.adapter.start();
    await harness.adapter.handleTurnLifecycleEvent?.(lifecycle("processing"));
    const stopping = harness.adapter.stop?.();
    await Promise.resolve();
    expect(harness.socketClosed).toBe(false);
    release();
    await stopping;
    expect(harness.socketClosed).toBe(true);
  });
});
