import { describe, expect, mock, test } from "bun:test";
import type { InboundChannelMessage } from "@/channels/types";
import {
  resolveSlackUserMentionsInMessage,
  sanitizeSlackUserDisplayName,
  stripSlackBotMention,
} from "./user-mentions";

describe("stripSlackBotMention", () => {
  test("removes only the authenticated bot mention", () => {
    expect(
      stripSlackBotMention("<@U_BOT> <@UALICE> please review", "U_BOT"),
    ).toBe("<@UALICE> please review");
  });

  test("handles labelled bot mentions without removing labelled humans", () => {
    expect(
      stripSlackBotMention(
        "<@UBOT|letta> ask <@UALICE|alice> and <@UBOB>",
        "UBOT",
      ),
    ).toBe("ask <@UALICE|alice> and <@UBOB>");
  });

  test("preserves bot mentions outside the leading routing position", () => {
    expect(
      stripSlackBotMention("<@UBOT> compare <@UBOT> with <@UALICE>", "UBOT"),
    ).toBe("compare <@UBOT> with <@UALICE>");
    expect(stripSlackBotMention("ask <@UBOT> to review", "UBOT")).toBe(
      "ask <@UBOT> to review",
    );
  });

  test("leaves all mentions intact when bot identity is unavailable", () => {
    expect(stripSlackBotMention(" <@UBOT> <@UALICE> hi ", null)).toBe(
      "<@UBOT> <@UALICE> hi",
    );
  });
});

describe("sanitizeSlackUserDisplayName", () => {
  test("neutralizes multiline and control-character display names", () => {
    expect(
      sanitizeSlackUserDisplayName(" Bob\n<admin>\u0000\\g<0> ", "UBOB"),
    ).toBe("Bob <admin> \\g<0>");
  });

  test("falls back to the stable user ID", () => {
    expect(sanitizeSlackUserDisplayName("\n\u0000", "UUNKNOWN")).toBe(
      "UUNKNOWN",
    );
  });
});

describe("resolveSlackUserMentionsInMessage", () => {
  test("resolves distinct users once across current, reply, and thread text", async () => {
    const resolveUserName = mock(async (userId: string) =>
      userId === "UALICE" ? "Alice" : "Bob",
    );
    const message: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "UCURRENT",
      text: "Ask <@UALICE> and <@UBOB|bob>",
      timestamp: 1,
      replyContext: { text: "Parent from <@UALICE>" },
      threadContext: {
        starter: { text: "Starter for <@UBOB>" },
        history: [{ text: "Again <@UALICE> then <@UALICE>" }],
      },
    };

    const resolved = await resolveSlackUserMentionsInMessage({
      message,
      resolveUserName,
    });

    expect(resolveUserName).toHaveBeenCalledTimes(2);
    expect(resolved.userMentions).toEqual([
      { start: 4, end: 13, userId: "UALICE", displayName: "Alice" },
      { start: 18, end: 29, userId: "UBOB", displayName: "Bob" },
    ]);
    expect(resolved.replyContext?.userMentions).toEqual([
      { start: 12, end: 21, userId: "UALICE", displayName: "Alice" },
    ]);
    expect(resolved.threadContext?.starter?.userMentions).toEqual([
      { start: 12, end: 19, userId: "UBOB", displayName: "Bob" },
    ]);
    expect(resolved.threadContext?.history?.[0]?.userMentions).toEqual([
      { start: 6, end: 15, userId: "UALICE", displayName: "Alice" },
      { start: 21, end: 30, userId: "UALICE", displayName: "Alice" },
    ]);
  });

  test("falls back to the stable ID when resolution fails", async () => {
    const message: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "UCURRENT",
      text: "Ask <@UUNKNOWN>",
      timestamp: 1,
    };
    const resolved = await resolveSlackUserMentionsInMessage({
      message,
      resolveUserName: async () => {
        throw new Error("users.info failed");
      },
    });

    expect(resolved.userMentions).toEqual([
      {
        start: 4,
        end: 15,
        userId: "UUNKNOWN",
        displayName: "UUNKNOWN",
      },
    ]);
  });

  test("returns the original object when no user mention exists", async () => {
    const message: InboundChannelMessage = {
      channel: "slack",
      chatId: "C123",
      senderId: "UCURRENT",
      text: "hello channel",
      timestamp: 1,
    };
    const resolved = await resolveSlackUserMentionsInMessage({
      message,
      resolveUserName: async () => "unused",
    });

    expect(resolved).toBe(message);
  });
});
