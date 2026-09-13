import { describe, expect, test } from "bun:test";
import { resolveSlackReactionIngressPolicy } from "./ingress-policy";

describe("resolveSlackReactionIngressPolicy", () => {
  const event = {
    user: "U555",
    item_user: "U123",
    reaction: "eyes",
    event_ts: "1712800001.000200",
    item: {
      type: "message",
      channel: "C123",
      ts: "1712800000.000100",
    },
  };

  test("normalizes a reaction into a channel ingress message", () => {
    expect(
      resolveSlackReactionIngressPolicy({
        event,
        action: "added",
        threadId: "1712790000.000050",
      }),
    ).toEqual({
      shouldRoute: true,
      channelId: "C123",
      senderId: "U555",
      messageId: "1712800001.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      text: "Slack reaction added: :eyes:",
      reaction: {
        action: "added",
        emoji: "eyes",
        targetMessageId: "1712800000.000100",
        targetSenderId: "U123",
      },
    });
  });

  test("falls back to the reacted-to message for an unknown channel thread", () => {
    const result = resolveSlackReactionIngressPolicy({
      event,
      action: "removed",
    });

    expect(result.shouldRoute && result.threadId).toBe("1712800000.000100");
  });

  test("leaves an unthreaded direct-message reaction unthreaded", () => {
    const result = resolveSlackReactionIngressPolicy({
      event: {
        ...event,
        item: { ...event.item, channel: "D123" },
      },
      action: "added",
    });

    expect(result.shouldRoute && result.threadId).toBeNull();
  });

  test("drops reactions from the app itself", () => {
    expect(
      resolveSlackReactionIngressPolicy({
        event,
        action: "added",
        botUserId: "U555",
      }),
    ).toEqual({ shouldRoute: false, reason: "own_bot_reaction" });
  });

  test("drops ambient reactions in mention-only channels", () => {
    expect(
      resolveSlackReactionIngressPolicy({
        event,
        action: "added",
        mentionOnlyChannels: ["C123"],
      }),
    ).toEqual({ shouldRoute: false, reason: "mention_only_channel" });
  });

  test("drops malformed reaction items", () => {
    expect(
      resolveSlackReactionIngressPolicy({
        event: { ...event, item: { type: "file" } },
        action: "added",
      }),
    ).toEqual({ shouldRoute: false, reason: "invalid_reaction_item" });
  });
});
