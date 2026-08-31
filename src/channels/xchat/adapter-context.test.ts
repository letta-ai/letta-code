import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import type {
  CustomChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";
import { createXChatAdapter } from "./adapter";
import {
  __testOverrideXChatRuntime,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
  type XChatSdkMessageLike,
  type XChatSdkReactionLike,
} from "./runtime";

let channelsRoot: string;

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-xchat-context-test-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(() => {
  __testOverrideXChatRuntime(null);
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

function makeAccount(): CustomChannelAccount {
  return {
    channel: "xchat",
    accountId: "xchat-test",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: {
      bot_token: "xcbot_test",
      pin: "1234",
      poll_interval_ms: 60_000,
      bootstrap_lookback_minutes: 10,
      group_mode: "mention-only",
      download_media: false,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("delivers encrypted reply context and reaction events", async () => {
  let handleIncomingMessage:
    | ((
        adapter: unknown,
        threadId: string,
        message: XChatSdkMessageLike,
      ) => Promise<void>)
    | undefined;
  let processReaction:
    | ((reaction: XChatSdkReactionLike) => Promise<void>)
    | undefined;
  const sdkAdapter: XChatSdkAdapterLike = {
    botUserId: "bot-user",
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async (host) => {
      const sdkHost = host as {
        handleIncomingMessage: typeof handleIncomingMessage;
        processReaction: typeof processReaction;
      };
      handleIncomingMessage = sdkHost.handleIncomingMessage;
      processReaction = sdkHost.processReaction;
    },
    disconnect: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "unused" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user" } }),
      getPublicKey: async () => ({ data: [{}] }),
    },
  };
  __testOverrideXChatRuntime({
    sdk: async () => ({ createXchatAdapter: () => sdkAdapter }),
    xdk: async () => ({
      Client: class {
        chat = apiClient.chat;
        users = apiClient.users;
      },
    }),
  });

  const received: InboundChannelMessage[] = [];
  const adapter = createXChatAdapter(makeAccount());
  adapter.onMessage = async (message) => {
    received.push(message);
  };
  await adapter.start();

  const reply: XChatSdkMessageLike = {
    id: "reply-message",
    text: "My reply",
    author: {
      userId: "sender-user",
      userName: "sender",
      fullName: "Sender",
    },
    metadata: { dateSent: new Date() },
    raw: {
      event: { id: "reply-message", conversationId: "dm-conversation" },
      decrypted: {
        replyPreviewValidation: "valid",
        content: {
          replyingToPreview: {
            replyingToMessageId: "original-message",
            senderId: "bot-user",
            senderDisplayName: "Bot",
            text: "Original text",
          },
        },
      },
    },
  };
  await handleIncomingMessage?.(sdkAdapter, "xchat:dm-conversation", reply);

  const reaction: XChatSdkReactionLike = {
    added: true,
    emoji: { name: "heart" },
    rawEmoji: "❤️",
    messageId: "original-message",
    threadId: "xchat:dm-conversation",
    user: {
      userId: "sender-user",
      userName: "sender",
      fullName: "Sender",
    },
    raw: {
      event: { id: "reaction-event" },
      decrypted: { createdAtMsec: 1_736_380_800_000, verified: true },
    },
  };
  await processReaction?.(reaction);
  await processReaction?.(reaction);

  expect(received).toHaveLength(2);
  expect(received[0]?.replyContext).toEqual({
    messageId: "original-message",
    senderId: "bot-user",
    senderName: "Bot",
    text: "Original text",
  });
  expect(received[1]).toMatchObject({
    channel: "xchat",
    chatId: "dm-conversation",
    senderId: "sender-user",
    senderName: "Sender",
    text: "X Chat reaction added: ❤️",
    timestamp: 1_736_380_800_000,
    messageId: "reaction-event",
    reaction: {
      action: "added",
      emoji: "❤️",
      targetMessageId: "original-message",
    },
  });
  await adapter.stop();
});
