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
    lidMapping?: { lidJid: string; phoneJid: string };
  } = {},
) {
  const presence: PresenceCall[] = [];
  let connectionUpdate: ((update: Record<string, unknown>) => void) | undefined;
  let socketClosed = false;
  const socket = {
    ev: {
      on(_event: string, _handler: (payload: unknown) => void) {},
    },
    ws: {
      close() {
        socketClosed = true;
      },
    },
    async sendMessage(_jid: string, _payload: Record<string, unknown>) {
      return { key: { id: "sent" } };
    },
    sendPresenceUpdate(presenceName: string, jid?: string) {
      presence.push({ jid, presence: presenceName });
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
    },
    {
      createSocket,
      loadRuntimeModule: async () => ({}),
      lidStore,
    },
  );
  trackedAdapters.push(adapter);
  return {
    adapter,
    presence,
    get socketClosed() {
      return socketClosed;
    },
    emitConnection(update: Record<string, unknown>) {
      connectionUpdate?.(update);
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

  test("transient reconnect and conflict clear owned typing without stale finish", async () => {
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
    expect(presenceNames(harness)).toEqual(["composing", "paused"]);
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
    await wait(0);
    expect(presenceNames(second)).toEqual(["composing", "paused"]);
    expect(second.adapter.isRunning?.()).toBe(false);
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
