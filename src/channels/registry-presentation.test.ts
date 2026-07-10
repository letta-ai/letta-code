import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadPendingControlRequestStore,
  __testOverrideSavePendingControlRequestStore,
  clearPendingControlRequestStore,
} from "@/channels/pending-control-requests";
import { buildSlackConversationSummary } from "@/channels/registry-presentation";

beforeEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

afterEach(() => {
  __testOverrideLoadPendingControlRequestStore(null);
  __testOverrideSavePendingControlRequestStore(null);
  clearPendingControlRequestStore();
});

describe("buildSlackConversationSummary", () => {
  test("labels direct messages with the sender name", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "D123",
        chatType: "direct",
        senderId: "U123",
        senderName: "Charles",
        text: "hey there",
      }),
    ).toBe("[Slack] DM with Charles");
  });

  test("labels threaded direct messages with a clipped text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "D123",
        chatType: "direct",
        threadId: "1712790000.000050",
        senderId: "U123",
        senderName: "Charles",
        text: "  following up in the DM thread about the deploy preview  ",
      }),
    ).toBe(
      "[Slack] DM thread with Charles: following up in the DM thread about the deploy preview",
    );
  });

  test("labels channel threads with a clipped text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "  what messages do you see in this thread right now?  ",
      }),
    ).toBe(
      "[Slack] Thread: what messages do you see in this thread right now?",
    );
  });

  test("includes the channel label when available", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatLabel: "#random",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "Need help with the deploy preview environment after lunch",
      }),
    ).toBe(
      "[Slack] Thread in #random: Need help with the deploy preview environment after lunch",
    );
  });

  test("falls back when a thread has no text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "   ",
      }),
    ).toBe("[Slack] Thread C123");
  });
});
