import { describe, expect, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import {
  createWhatsAppTypingController,
  type WhatsAppTypingPresence,
  type WhatsAppTypingTurn,
} from "./typing-controller";

const wait = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function source(overrides: Partial<ChannelTurnSource> = {}): ChannelTurnSource {
  return {
    channel: "whatsapp",
    accountId: "wa-1",
    chatId: "15550000001@s.whatsapp.net",
    messageId: "message-1",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conversation-1",
    ...overrides,
  };
}

function turn(
  overrides: { batchId?: string; source?: Partial<ChannelTurnSource> } = {},
): WhatsAppTypingTurn {
  return {
    batchId: overrides.batchId ?? "batch-1",
    source: source(overrides.source),
  };
}

type Owner = { id: string };
type PresenceCall = {
  owner: Owner;
  chatId: string;
  presence: WhatsAppTypingPresence;
};

function makeController(
  calls: PresenceCall[],
  options: {
    owner?: Owner | null;
    refreshMs?: number;
    maxLifetimeMs?: number;
    sendPresence?: (
      owner: Owner,
      chatId: string,
      presence: WhatsAppTypingPresence,
    ) => unknown;
  } = {},
) {
  let owner: Owner | null = options.owner ?? { id: "socket-1" };
  return {
    setOwner(next: Owner | null) {
      owner = next;
    },
    owner() {
      return owner;
    },
    controller: createWhatsAppTypingController<Owner>({
      accountId: "wa-1",
      canonicalizeChatId: (chatId) =>
        chatId.endsWith("@lid") ? "15550000001@s.whatsapp.net" : chatId,
      getOwner: () => owner,
      sendPresence:
        options.sendPresence ??
        ((callOwner, chatId, presence) => {
          calls.push({ owner: callOwner, chatId, presence });
        }),
      refreshMs: options.refreshMs,
      maxLifetimeMs: options.maxLifetimeMs,
    }),
  };
}

describe("WhatsApp typing controller", () => {
  test("accepts only matching WhatsApp account sources with an active owner", () => {
    const calls: PresenceCall[] = [];
    const harness = makeController(calls);
    harness.controller.start(turn({ source: { channel: "telegram" } }));
    harness.controller.start(turn({ source: { accountId: "wa-2" } }));
    harness.setOwner(null);
    harness.controller.start(turn());
    expect(calls).toEqual([]);
  });

  test("deduplicates processing and pauses after the final stop", async () => {
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls);
    const activeTurn = turn();
    controller.start(activeTurn);
    controller.start(activeTurn);
    expect(calls.map(({ chatId, presence }) => ({ chatId, presence }))).toEqual(
      [{ chatId: activeTurn.source.chatId, presence: "composing" }],
    );
    await controller.stop(activeTurn);
    expect(calls.at(-1)?.presence).toBe("paused");
    expect(controller.isActive(activeTurn.source.chatId)).toBe(false);
  });

  test("reference-counts multiple sources in one batch and chat", async () => {
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls);
    const first = turn({ source: { messageId: "message-1" } });
    const second = turn({ source: { messageId: "message-2" } });
    controller.start(first);
    controller.start(second);
    await controller.stop(first);
    expect(calls).toHaveLength(1);
    expect(controller.isActive(first.source.chatId)).toBe(true);
    await controller.stop(second);
    expect(calls.at(-1)?.presence).toBe("paused");
  });

  test("supersedes an older batch without letting its finish pause the new owner", async () => {
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls);
    const older = turn({ batchId: "batch-1" });
    const newer = turn({
      batchId: "batch-2",
      source: { messageId: "message-2" },
    });

    controller.start(older);
    controller.start(newer);
    await controller.stop(older);
    expect(calls.map((call) => call.presence)).toEqual([
      "composing",
      "composing",
    ]);
    expect(controller.isActive(newer.source.chatId)).toBe(true);

    await controller.stop(newer);
    expect(calls.map((call) => call.presence)).toEqual([
      "composing",
      "composing",
      "paused",
    ]);
  });

  test("refreshes and enforces max lifetime with short timings", async () => {
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls, {
      refreshMs: 8,
      maxLifetimeMs: 25,
    });
    controller.start(turn());
    await wait(15);
    expect(
      calls.filter((call) => call.presence === "composing").length,
    ).toBeGreaterThan(1);
    await wait(20);
    expect(controller.isActive(source().chatId)).toBe(false);
    expect(calls.at(-1)?.presence).toBe("paused");
  });

  test("canonicalizes JIDs and contains sync/async presence failures", async () => {
    const calls: string[] = [];
    const controller = createWhatsAppTypingController<Owner>({
      accountId: "wa-1",
      canonicalizeChatId: () => "15550000001@s.whatsapp.net",
      getOwner: () => ({ id: "socket-1" }),
      refreshMs: 8,
      maxLifetimeMs: 30,
      sendPresence: (_owner, _chatId, presence) => {
        calls.push(presence);
        if (presence === "composing") throw new Error("sync failure");
        return Promise.reject(new Error("async failure"));
      },
    });
    expect(() =>
      controller.start(turn({ source: { chatId: "123@lid" } })),
    ).not.toThrow();
    await wait(12);
    await controller.clearChat("123@lid");
    expect(calls).toContain("paused");
  });

  test("deletes timer state before awaiting paused presence", async () => {
    let releasePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls, {
      sendPresence: (owner, chatId, presence) => {
        calls.push({ owner, chatId, presence });
        return presence === "paused" ? paused : undefined;
      },
    });
    const activeTurn = turn();
    controller.start(activeTurn);
    const clearing = controller.clearChat(activeTurn.source.chatId);
    expect(controller.isActive(activeTurn.source.chatId)).toBe(false);
    releasePaused();
    await clearing;
  });

  test("clearOwner uses the socket that owns typing and does not touch newer sockets", async () => {
    const calls: PresenceCall[] = [];
    const ownerA = { id: "socket-a" };
    const ownerB = { id: "socket-b" };
    const harness = makeController(calls, { owner: ownerA });
    harness.controller.start(turn({ batchId: "batch-a" }));
    harness.setOwner(ownerB);
    harness.controller.start(turn({ batchId: "batch-b" }));

    await harness.controller.clearOwner(ownerA);
    expect(harness.controller.isActive(source().chatId)).toBe(true);
    expect(calls.map((call) => [call.owner.id, call.presence])).toEqual([
      ["socket-a", "composing"],
      ["socket-b", "composing"],
    ]);

    await harness.controller.clearOwner(ownerB);
    expect(harness.controller.isActive(source().chatId)).toBe(false);
    expect(calls.map((call) => [call.owner.id, call.presence])).toEqual([
      ["socket-a", "composing"],
      ["socket-b", "composing"],
      ["socket-b", "paused"],
    ]);
  });

  test("clearChat and clearAll cancel active chats", async () => {
    const calls: PresenceCall[] = [];
    const { controller } = makeController(calls);
    const first = turn();
    const second = turn({
      source: {
        chatId: "15550000002@s.whatsapp.net",
        messageId: "message-2",
      },
    });
    controller.start(first);
    controller.start(second);
    await controller.clearChat(first.source.chatId);
    expect(controller.isActive(first.source.chatId)).toBe(false);
    expect(controller.isActive(second.source.chatId)).toBe(true);
    await controller.clearAll();
    expect(controller.isActive(second.source.chatId)).toBe(false);
    expect(calls.filter((call) => call.presence === "paused")).toHaveLength(2);
  });
});
