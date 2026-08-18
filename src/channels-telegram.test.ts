import { describe, expect, test } from "bun:test";
import {
  buildTelegramDebounceKey,
  buildTelegramRichMessagePayload,
  createTelegramMessageActionAdapter,
  detectTelegramBotMention,
  diffTelegramReactionUpdate,
  getTelegramChatType,
  getTelegramReplyContext,
  parseTelegramReactionInput,
  type TelegramLikeMessage,
} from "@/channels-telegram";

function makeMessage(
  overrides: Partial<TelegramLikeMessage> = {},
): TelegramLikeMessage {
  return {
    message_id: 42,
    date: 1_755_000_000,
    text: "hello",
    chat: { id: -100123, type: "supergroup", title: "letta" },
    from: { id: 7, username: "charles" },
    ...overrides,
  };
}

describe("public Telegram ingress primitives", () => {
  test("detects @username mentions and strips the leading routing token", () => {
    const result = detectTelegramBotMention(
      makeMessage({ text: "@letta_bot deploy the fix" }),
      "letta_bot",
    );
    expect(result).toEqual({ isMention: true, text: "deploy the fix" });
  });

  test("does not treat plain text as a mention", () => {
    const result = detectTelegramBotMention(
      makeMessage({ text: "deploy the fix" }),
      "letta_bot",
    );
    expect(result.isMention).toBe(false);
  });

  test("classifies chats the same way the local adapter does", () => {
    expect(getTelegramChatType({ type: "private" })).toBe("direct");
    expect(getTelegramChatType({ type: "supergroup" })).toBe("channel");
    expect(getTelegramChatType({})).toBe("direct");
  });

  test("builds reply context from reply_to_message", () => {
    const context = getTelegramReplyContext(
      makeMessage({
        reply_to_message: makeMessage({
          message_id: 9,
          text: "original",
          from: { id: 3, first_name: "Ada" },
        }),
      }),
    );
    expect(context).toEqual({
      messageId: "9",
      senderId: "3",
      senderName: "Ada",
      text: "original",
    });
  });

  test("diffs reaction updates into added/removed events", () => {
    expect(
      diffTelegramReactionUpdate({
        old_reaction: [{ type: "emoji", emoji: "👍" }],
        new_reaction: [{ type: "emoji", emoji: "🔥" }],
      }),
    ).toEqual([
      { action: "removed", emoji: "👍" },
      { action: "added", emoji: "🔥" },
    ]);
  });

  test("derives the same debounce key as the local adapter", () => {
    expect(
      buildTelegramDebounceKey({ chatId: "-100123", threadId: "42" }, "bot-1"),
    ).toBe("telegram:bot-1:-100123:42");
    expect(buildTelegramDebounceKey({ chatId: " " }, "bot-1")).toBeNull();
  });
});

describe("public Telegram outbound primitives", () => {
  test("builds rich message payloads with thread and reply routing", () => {
    expect(
      buildTelegramRichMessagePayload({
        chatId: "-100123",
        threadId: "7",
        replyToMessageId: "42",
        richMessage: { markdown: "# hi" },
      }),
    ).toEqual({
      chat_id: "-100123",
      message_thread_id: 7,
      reply_parameters: { message_id: 42 },
      rich_message: { markdown: "# hi" },
    });
  });

  test("parses emoji and custom emoji reaction inputs", () => {
    expect(parseTelegramReactionInput("👍")).toEqual({
      type: "emoji",
      emoji: "👍",
    });
    expect(parseTelegramReactionInput("custom_emoji:abc")).toEqual({
      type: "custom_emoji",
      custom_emoji_id: "abc",
    });
    expect(parseTelegramReactionInput("  ")).toBeNull();
  });
});

describe("public Telegram message action adapter", () => {
  const route = {
    accountId: "bot-1",
    chatId: "-100123",
    chatType: "channel" as const,
    threadId: null,
    agentId: "agent-1",
    conversationId: "conv-1",
  };

  test("sends through the injected transport with formatted text", async () => {
    const sent: unknown[] = [];
    const actions = createTelegramMessageActionAdapter();
    const result = await actions.handleAction({
      request: { action: "send", chatId: "-100123", message: "**hi**" },
      route,
      adapter: {
        sendMessage: async (msg: { richMessage?: unknown }) => {
          sent.push(msg);
          return { messageId: "555" };
        },
      },
      formatText: (text: string) => ({ text, parseMode: "HTML" }),
    } as never);

    expect(result).toBe("Message sent to telegram (message_id: 555)");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: "telegram",
      chatId: "-100123",
      parseMode: "HTML",
    });
  });

  test("uses the injected rich private chat default", async () => {
    const sent: Array<{ richMessage?: unknown }> = [];
    const actions = createTelegramMessageActionAdapter({
      richPrivateChatDefaultEnabled: () => false,
    });
    await actions.handleAction({
      request: { action: "send", chatId: "777", message: "hi" },
      route: { ...route, chatId: "777", chatType: "direct" as const },
      adapter: {
        sendMessage: async (msg: { richMessage?: unknown }) => {
          sent.push(msg);
          return { messageId: "1" };
        },
      },
      formatText: (text: string) => ({ text }),
    } as never);

    expect(sent[0]?.richMessage).toBeUndefined();
  });

  test("validates reactions before touching the transport", async () => {
    const actions = createTelegramMessageActionAdapter();
    const result = await actions.handleAction({
      request: { action: "react", chatId: "-100123", emoji: "" },
      route,
      adapter: {
        sendMessage: async () => {
          throw new Error("transport must not be called");
        },
      },
      formatText: (text: string) => ({ text }),
    } as never);
    expect(result).toBe("Error: Telegram react requires emoji.");
  });
});
