import { describe, expect, test } from "bun:test";
import {
  buildChannelConversationListMessage,
  parseChannelConversationCommand,
} from "@/channels/conversation-command";

describe("channel conversation command helpers", () => {
  test("/conv help parsing is case-insensitive", () => {
    expect(parseChannelConversationCommand("HELP")).toEqual({
      action: "menu",
    });
    expect(parseChannelConversationCommand("Help")).toEqual({
      action: "menu",
    });
  });

  test("list messages make capped agent-wide pagination explicit", () => {
    const text = buildChannelConversationListMessage(
      "telegram",
      {
        accountId: "acct-telegram",
        chatId: "chat-1",
        chatType: "direct",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
        enabled: true,
        createdAt: "2026-05-18T00:00:00.000Z",
      },
      [
        { id: "conv-1", summary: "Current" },
        { id: "conv-2", summary: "Older" },
      ],
      { hasMore: true },
    );

    expect(text).toContain("Telegram recent conversations for routed agent");
    expect(text).toContain("Showing up to 8 conversations.");
    expect(text).toContain("Use /conv list conv-2 to show more.");
  });
});
