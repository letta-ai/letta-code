import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboundChannelMessage } from "@/channels/types";
import {
  createWhatsAppAdapter,
  type WhatsAppAdapterDependencies,
} from "./adapter";
import { createLidStore } from "./lid-store";

const PHONE = "15550000001@s.whatsapp.net";
const REACTOR = "15550000002@s.whatsapp.net";
const GROUP = "120363-987@g.us";

const temporaryDirectories: string[] = [];
const trackedAdapters: Array<ReturnType<typeof createWhatsAppAdapter>> = [];

const account = {
  channel: "whatsapp" as const,
  accountId: "reaction-adapter",
  displayName: "WhatsApp",
  enabled: true,
  dmPolicy: "pairing" as const,
  allowedUsers: [],
  agentId: "agent-1",
  selfChatMode: false,
  groupMode: "open" as const,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "whatsapp-reactions-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function reactionEntry(
  overrides: {
    chatId?: string;
    targetId?: string;
    reactionId?: string;
    targetFromMe?: boolean;
    reactionFromMe?: boolean;
    participant?: string;
    text?: unknown;
    senderTimestampMs?: unknown;
  } = {},
): Record<string, unknown> {
  const chatId = overrides.chatId ?? REACTOR;
  return {
    key: {
      remoteJid: chatId,
      id: overrides.targetId ?? "target-message",
      fromMe: overrides.targetFromMe ?? true,
    },
    reaction: {
      key: {
        remoteJid: chatId,
        id: overrides.reactionId ?? "reaction-event",
        fromMe: overrides.reactionFromMe ?? false,
        participant: overrides.participant ?? REACTOR,
      },
      text: overrides.text === undefined ? "👍" : overrides.text,
      senderTimestampMs:
        overrides.senderTimestampMs === undefined
          ? Date.now()
          : overrides.senderTimestampMs,
    },
  };
}

function makeHarness(
  options: {
    account?: Omit<Partial<typeof account>, "groupMode"> & {
      groupMode?: "disabled" | "mention" | "open";
    };
    lidEntries?: Array<{ lid: string; phone: string }>;
    deliver?: (message: InboundChannelMessage) => Promise<void> | void;
    /** When set, sendMessage returns this as the outbound message ID. */
    outboundMessageId?: string;
  } = {},
) {
  const directory = temporaryDirectory();
  const lidPath = join(directory, "lid-mappings.json");
  if (options.lidEntries) {
    writeFileSync(lidPath, JSON.stringify({ entries: options.lidEntries }));
  }
  const delivered: InboundChannelMessage[] = [];
  const eventNames: string[] = [];
  const handlers = new Map<string, (payload: unknown) => unknown>();
  let connectionUpdate: ((update: unknown) => void) | undefined;
  let readCalls = 0;
  const outboundId = options.outboundMessageId ?? "sent-echo";
  const socket = {
    ev: {
      on(event: string, handler: (payload: unknown) => unknown) {
        eventNames.push(event);
        handlers.set(event, handler);
      },
    },
    user: { id: PHONE, lid: "999999@lid" },
    ws: { close() {} },
    readMessages() {
      readCalls += 1;
      return Promise.resolve();
    },
    async sendMessage() {
      return { key: { id: outboundId, fromMe: true, remoteJid: REACTOR } };
    },
    async sendPresenceUpdate() {},
  };
  const createSocket: NonNullable<
    WhatsAppAdapterDependencies["createSocket"]
  > = async (params) => {
    connectionUpdate = params.onConnectionUpdate as unknown as (
      update: unknown,
    ) => void;
    return {
      sock: socket,
      saveCreds: async () => undefined,
      DisconnectReason: {},
      release: () => undefined,
    };
  };
  const adapter = createWhatsAppAdapter(
    { ...account, ...options.account },
    {
      createSocket,
      loadRuntimeModule: async () => ({}),
      lidStore: createLidStore(lidPath),
    },
  );
  adapter.onMessage = async (message) => {
    delivered.push(message);
    await options.deliver?.(message);
  };
  trackedAdapters.push(adapter);

  return {
    adapter,
    delivered,
    eventNames,
    readCalls: () => readCalls,
    async start() {
      await adapter.start();
      connectionUpdate?.({ connection: "open" });
    },
    async emit(entries: unknown[]) {
      await handlers.get("messages.reaction")?.(entries);
    },
    async emitUpsert(messages: unknown[], type: string = "notify") {
      await handlers.get("messages.upsert")?.({ type, messages });
    },
  };
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

describe("WhatsApp reaction adapter integration", () => {
  test("registers messages.reaction and dispatches a direct reaction", async () => {
    const harness = makeHarness();
    await harness.start();
    expect(harness.eventNames).toEqual([
      "messages.upsert",
      "messages.reaction",
    ]);
    await harness.emit([reactionEntry()]);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.reaction).toEqual({
      action: "added",
      emoji: "👍",
      targetMessageId: "target-message",
      targetSenderId: "15550000001",
    });
  });

  test("emits structured text and canonical target metadata", async () => {
    const harness = makeHarness();
    await harness.start();
    const raw = reactionEntry({ reactionId: "reaction-1" });
    await harness.emit([raw]);
    const message = harness.delivered[0];
    expect(message).toEqual(
      expect.objectContaining({
        chatId: REACTOR,
        senderId: "15550000002",
        text: "15550000002 reacted 👍",
        messageId: "reaction-1",
        chatType: "direct",
        isMention: true,
        raw,
      }),
    );
    expect(harness.readCalls()).toBe(0);
  });

  test("dispatches empty and null reactions as removals", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.emit([
      reactionEntry({ reactionId: "removed-empty", text: "" }),
      reactionEntry({ reactionId: "removed-null", text: null }),
    ]);
    expect(harness.delivered.map((message) => message.reaction)).toEqual([
      {
        action: "removed",
        emoji: "",
        targetMessageId: "target-message",
        targetSenderId: "15550000001",
      },
      {
        action: "removed",
        emoji: "",
        targetMessageId: "target-message",
        targetSenderId: "15550000001",
      },
    ]);
  });

  test("resolves known direct LIDs and fails closed for unknown/conflicting LIDs", async () => {
    const known = makeHarness({
      lidEntries: [{ lid: "777777@lid", phone: REACTOR }],
    });
    await known.start();
    await known.emit([
      reactionEntry({
        chatId: "777777@lid",
        participant: "777777@lid",
      }),
    ]);
    expect(known.delivered[0]?.chatId).toBe(REACTOR);
    expect(known.delivered[0]?.senderId).toBe("15550000002");
    expect(known.delivered[0]?.reaction?.targetSenderId).toBe("15550000001");

    const unknown = makeHarness();
    await unknown.start();
    await unknown.emit([
      reactionEntry({
        chatId: "888888@lid",
        participant: "888888@lid",
      }),
    ]);
    expect(unknown.delivered).toHaveLength(0);

    const conflicting = makeHarness({
      lidEntries: [
        { lid: "999888@lid", phone: REACTOR },
        { lid: "999888@lid", phone: "15550000003@s.whatsapp.net" },
      ],
    });
    await conflicting.start();
    await conflicting.emit([
      reactionEntry({
        chatId: "999888@lid",
        participant: "999888@lid",
      }),
    ]);
    expect(conflicting.delivered).toHaveLength(0);
  });

  test("enforces group policy and preserves mention semantics", async () => {
    const cases: Array<{
      groupMode: "disabled" | "mention" | "open";
      allowedGroups?: string[];
      expected: boolean;
      id: string;
    }> = [
      { groupMode: "disabled", expected: false, id: "group-disabled" },
      { groupMode: "open", expected: true, id: "group-open" },
      {
        groupMode: "open",
        allowedGroups: ["120363-other@g.us"],
        expected: false,
        id: "group-denied",
      },
      {
        groupMode: "mention",
        allowedGroups: [GROUP],
        expected: true,
        id: "group-mention",
      },
    ];
    for (const policy of cases) {
      const harness = makeHarness({ account: policy });
      await harness.start();
      await harness.emit([
        reactionEntry({
          chatId: GROUP,
          reactionId: policy.id,
          participant: REACTOR,
        }),
      ]);
      expect(harness.delivered).toHaveLength(policy.expected ? 1 : 0);
      if (policy.expected) {
        expect(harness.delivered[0]?.chatType).toBe("channel");
        expect(harness.delivered[0]?.isMention).toBe(
          policy.groupMode === "mention",
        );
      }
    }
  });

  test("drops non-owned targets and own reaction envelopes", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.emit([
      reactionEntry({ targetId: "not-ours", targetFromMe: false }),
      reactionEntry({ reactionId: "own-reaction", reactionFromMe: true }),
    ]);
    expect(harness.delivered).toHaveLength(0);
  });

  test("drops old, sent-echo, and duplicate reaction events", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.emit([
      reactionEntry({
        reactionId: "old",
        senderTimestampMs: Date.now() - 10_000,
      }),
    ]);
    await harness.emit([
      reactionEntry({ reactionId: "duplicate" }),
      reactionEntry({ reactionId: "duplicate" }),
    ]);
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: REACTOR,
      text: "",
      reaction: "👍",
      targetMessageId: "target-message",
    });
    await harness.emit([reactionEntry({ reactionId: "sent-echo" })]);
    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.messageId).toBe("duplicate");
  });

  test("deduplicates reaction IDs within a canonical chat only", async () => {
    const harness = makeHarness();
    await harness.start();
    await harness.emit([
      reactionEntry({
        chatId: REACTOR,
        reactionId: "shared-id",
        participant: REACTOR,
      }),
      reactionEntry({
        chatId: "15550000003@s.whatsapp.net",
        reactionId: "shared-id",
        participant: "15550000003@s.whatsapp.net",
      }),
      reactionEntry({
        chatId: REACTOR,
        reactionId: "shared-id",
        participant: REACTOR,
      }),
    ]);
    expect(harness.delivered.map((message) => message.chatId)).toEqual([
      REACTOR,
      "15550000003@s.whatsapp.net",
    ]);
  });

  test("continues after malformed entries and rejected delivery", async () => {
    const rejected = makeHarness({
      deliver: async (message) => {
        if (message.messageId === "reject-me") {
          throw new Error("delivery failed");
        }
      },
    });
    await rejected.start();
    await rejected.emit([
      { malformed: true },
      reactionEntry({ reactionId: "reject-me" }),
      reactionEntry({ reactionId: "after-rejection" }),
    ]);
    expect(rejected.delivered.map((message) => message.messageId)).toEqual([
      "reject-me",
      "after-rejection",
    ]);
  });

  test("LID reaction against own outbound with target.fromMe:false is recognized", async () => {
    // Exact live-evidence shape: Baileys delivers the reaction via a LID chat
    // where it cannot equate Samantha's PN identity, so target.fromMe is false
    // even though we sent the message.
    const LID = "210565536456917@lid";
    const harness = makeHarness({
      lidEntries: [{ lid: LID, phone: REACTOR }],
      outboundMessageId: "outbound-1",
    });
    await harness.start();

    // Step 1: send outbound text — populates sentMessageIds + messageStore.
    await harness.adapter.sendMessage({
      channel: "whatsapp",
      accountId: account.accountId,
      chatId: REACTOR,
      text: "hello",
    });

    // Step 2: emit outbound upsert echo — sentMessageIds entry consumed,
    // but messageStore entry survives with key.fromMe: true.
    await harness.emitUpsert([
      {
        key: {
          remoteJid: LID,
          id: "outbound-1",
          fromMe: true,
        },
        message: { conversation: "hello" },
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ]);

    // Step 3: emit real-shape LID reaction with target.fromMe: false.
    await harness.emit([
      reactionEntry({
        chatId: LID,
        targetId: "outbound-1",
        targetFromMe: false,
        reactionId: "lid-reaction-1",
        participant: LID,
      }),
    ]);

    expect(harness.delivered).toHaveLength(1);
    expect(harness.delivered[0]?.reaction).toEqual({
      action: "added",
      emoji: "👍",
      targetMessageId: "outbound-1",
      targetSenderId: "15550000001",
    });
  });

  test("unknown targetFromMe:false target remains dropped", async () => {
    const harness = makeHarness();
    await harness.start();

    await harness.emit([
      reactionEntry({
        targetId: "not-in-any-store",
        targetFromMe: false,
        reactionId: "unknown-target",
      }),
    ]);
    expect(harness.delivered).toHaveLength(0);
  });

  test("target stored from inbound message with key.fromMe:false remains dropped", async () => {
    // An inbound message (fromMe: false) is stored in messageStore by the
    // upsert handler. A reaction to it must NOT be treated as "ours."
    const harness = makeHarness();
    await harness.start();

    // Simulate an inbound message arriving via upsert.
    await harness.emitUpsert([
      {
        key: {
          remoteJid: REACTOR,
          id: "inbound-msg-1",
          fromMe: false,
        },
        message: { conversation: "hi from user" },
        messageTimestamp: Math.floor(Date.now() / 1000),
        pushName: "User",
      },
    ]);
    // The upsert handler should have delivered it as a normal inbound.
    expect(harness.delivered).toHaveLength(1);

    // Now react to that inbound message — target.fromMe is false and the
    // messageStore entry has fromMe: false. Must be dropped.
    await harness.emit([
      reactionEntry({
        targetId: "inbound-msg-1",
        targetFromMe: false,
        reactionId: "react-to-inbound",
      }),
    ]);
    // Still just the original inbound, no reaction delivered.
    expect(harness.delivered).toHaveLength(1);
  });
});
