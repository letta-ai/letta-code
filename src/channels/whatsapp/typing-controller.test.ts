import { describe, expect, test } from "bun:test";
import type { ChannelTurnSource } from "@/channels/types";
import {
  createWhatsAppTypingController,
  type WhatsAppTypingPresence,
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

function makeController(
  calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }>,
  overrides: Partial<Parameters<typeof createWhatsAppTypingController>[0]> = {},
) {
  return createWhatsAppTypingController({
    accountId: "wa-1",
    canonicalizeChatId: (chatId) =>
      chatId.endsWith("@lid") ? "15550000001@s.whatsapp.net" : chatId,
    sendPresence: (chatId, presence) => calls.push({ chatId, presence }),
    ...overrides,
  });
}

describe("WhatsApp typing controller", () => {
  test("accepts only matching WhatsApp account sources", () => {
    const calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }> =
      [];
    const controller = makeController(calls);
    controller.start(source({ channel: "telegram" }));
    controller.start(source({ accountId: "wa-2" }));
    expect(calls).toEqual([]);
  });

  test("deduplicates processing and pauses after the final stop", async () => {
    const calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }> =
      [];
    const controller = makeController(calls);
    const turn = source();
    controller.start(turn);
    controller.start(turn);
    expect(calls).toEqual([{ chatId: turn.chatId, presence: "composing" }]);
    await controller.stop(turn);
    expect(calls.at(-1)?.presence).toBe("paused");
    expect(controller.isActive(turn.chatId)).toBe(false);
  });

  test("reference-counts multiple sources in one chat", async () => {
    const calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }> =
      [];
    const controller = makeController(calls);
    const first = source({ messageId: "message-1" });
    const second = source({ messageId: "message-2" });
    controller.start(first);
    controller.start(second);
    await controller.stop(first);
    expect(calls).toHaveLength(1);
    expect(controller.isActive(first.chatId)).toBe(true);
    await controller.stop(second);
    expect(calls.at(-1)?.presence).toBe("paused");
  });

  test("refreshes and enforces max lifetime with short timings", async () => {
    const calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }> =
      [];
    const controller = makeController(calls, {
      refreshMs: 8,
      maxLifetimeMs: 25,
    });
    controller.start(source());
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
    const controller = createWhatsAppTypingController({
      accountId: "wa-1",
      canonicalizeChatId: () => "15550000001@s.whatsapp.net",
      refreshMs: 8,
      maxLifetimeMs: 30,
      sendPresence: (_chatId, presence) => {
        calls.push(presence);
        if (presence === "composing") throw new Error("sync failure");
        return Promise.reject(new Error("async failure"));
      },
    });
    expect(() => controller.start(source({ chatId: "123@lid" }))).not.toThrow();
    await wait(12);
    await controller.clearChat("123@lid");
    expect(calls).toContain("paused");
  });

  test("deletes timer state before awaiting paused presence", async () => {
    let releasePaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      releasePaused = resolve;
    });
    const controller = makeController([], {
      sendPresence: (_chatId, presence) =>
        presence === "paused" ? paused : undefined,
    });
    const turn = source();
    controller.start(turn);
    const clearing = controller.clearChat(turn.chatId);
    expect(controller.isActive(turn.chatId)).toBe(false);
    releasePaused();
    await clearing;
  });

  test("clearChat and clearAll cancel active chats", async () => {
    const calls: Array<{ chatId: string; presence: WhatsAppTypingPresence }> =
      [];
    const controller = makeController(calls);
    const first = source();
    const second = source({
      chatId: "15550000002@s.whatsapp.net",
      messageId: "message-2",
    });
    controller.start(first);
    controller.start(second);
    await controller.clearChat(first.chatId);
    expect(controller.isActive(first.chatId)).toBe(false);
    expect(controller.isActive(second.chatId)).toBe(true);
    await controller.clearAll();
    expect(controller.isActive(second.chatId)).toBe(false);
    expect(calls.filter((call) => call.presence === "paused")).toHaveLength(2);
  });
});
