import { describe, expect, test } from "bun:test";
import {
  buildChannelConversationForkedMessage,
  buildChannelConversationListMessage,
  buildChannelConversationMenuMessage,
  buildChannelConversationNewMessage,
  buildChannelConversationSwitchedMessage,
  buildChannelConversationWrongAgentMessage,
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

  test("menu messages put the current conversation id in inline code", () => {
    const text = buildChannelConversationMenuMessage("telegram", {
      accountId: "acct-telegram",
      chatId: "chat-1",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conv-1",
      enabled: true,
      createdAt: "2026-05-18T00:00:00.000Z",
    });

    expect(text).toContain("Current conversation: `conv-1`");
    expect(text).not.toContain("```");
    expect(text).not.toContain("Current: conv-1");
    expect(text).toContain("/conv list [last_conversation_id]");
    expect(text).not.toContain("after_id");
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
    expect(text).toContain(
      "Showing 2 recent conversations newest first. Page size is 8.",
    );
    expect(text).toContain("Current (current): `conv-1`");
    expect(text).toContain("Older: `conv-2`");
    expect(text).toContain(
      "Use /conv list `conv-2` to show older conversations.",
    );
    expect(text).not.toContain("```");
    expect(text).not.toContain("after_id");
  });

  test("state-changing conversation replies put conversation ids in inline code", () => {
    expect(buildChannelConversationNewMessage("telegram", "conv-new")).toBe(
      "Telegram started a new conversation for this chat: `conv-new`",
    );
    expect(
      buildChannelConversationSwitchedMessage("telegram", "conv-target"),
    ).toBe("Telegram switched this chat to conversation: `conv-target`");
    expect(
      buildChannelConversationForkedMessage(
        "telegram",
        "conv-source",
        "conv-fork",
      ),
    ).toBe("Telegram forked this chat.\nFrom: `conv-source`\nTo: `conv-fork`");
    expect(
      buildChannelConversationWrongAgentMessage("telegram", "conv-other"),
    ).toBe(
      "Telegram cannot switch to this conversation because it belongs to a different agent: `conv-other`",
    );
  });
});
