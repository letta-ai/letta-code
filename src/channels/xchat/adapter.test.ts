import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import type {
  CustomChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";
import { createXChatAdapter } from "./adapter";
import { XChatPollState } from "./poll-state";
import {
  __testOverrideXChatRuntime,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
  type XChatSdkMessageLike,
} from "./runtime";

let channelsRoot: string;

function makeAccount(
  overrides: Record<string, unknown> = {},
): CustomChannelAccount {
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
      download_media: true,
      media_max_bytes: 1024 * 1024,
      ...overrides,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeMessage(params: {
  id: string;
  text: string;
  conversationId: string;
  ageMs?: number;
  isMe?: boolean;
  isMention?: boolean;
}): XChatSdkMessageLike {
  return {
    id: params.id,
    text: params.text,
    isMention: params.isMention,
    author: {
      userId: params.isMe ? "bot-user" : "sender-user",
      userName: params.isMe ? "bot" : "sender",
      fullName: params.isMe ? "Bot" : "Sender",
      isMe: params.isMe,
    },
    metadata: { dateSent: new Date(Date.now() - (params.ageMs ?? 0)) },
    raw: { conversationId: params.conversationId },
  };
}

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-xchat-test-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(() => {
  __testOverrideXChatRuntime(null);
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("polls encrypted conversations, applies bootstrap rules, and persists dedupe state", async () => {
  const conversations = ["dm-conversation", "g-group"];
  const messages = new Map<string, XChatSdkMessageLike[]>([
    [
      "dm-conversation",
      [
        makeMessage({
          id: "old-message",
          text: "old",
          conversationId: "dm-conversation",
          ageMs: 60 * 60 * 1000,
        }),
        makeMessage({
          id: "recent-message",
          text: "hello",
          conversationId: "dm-conversation",
        }),
        makeMessage({
          id: "own-message",
          text: "sent by bot",
          conversationId: "dm-conversation",
          isMe: true,
        }),
      ],
    ],
    [
      "g-group",
      [
        makeMessage({
          id: "ambient-group-message",
          text: "ambient",
          conversationId: "g-group",
          isMention: false,
        }),
        makeMessage({
          id: "mentioned-group-message",
          text: "@bot hello",
          conversationId: "g-group",
          isMention: true,
        }),
      ],
    ],
  ]);

  const sdkAdapter: XChatSdkAdapterLike = {
    botUserId: "bot-user",
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    async fetchMessages(threadId) {
      return { messages: messages.get(threadId.slice("xchat:".length)) ?? [] };
    },
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({
        data: conversations.map((id) => ({ id })),
      }),
    },
    users: {
      getMe: async () => ({ data: { id: "bot-user", username: "bot" } }),
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

  expect(received.map((message) => message.messageId)).toEqual([
    "recent-message",
  ]);
  expect(received[0]).toMatchObject({
    channel: "xchat",
    chatId: "dm-conversation",
    senderId: "sender-user",
    chatType: "direct",
    routedBy: "dm",
  });
  messages.set("dm-conversation", [
    ...(messages.get("dm-conversation") ?? []),
    makeMessage({
      id: "next-message",
      text: "next",
      conversationId: "dm-conversation",
    }),
  ]);
  await adapter.pollNow();
  expect(received.map((message) => message.messageId)).toEqual([
    "recent-message",
    "next-message",
  ]);
  await adapter.stop();

  const restarted = createXChatAdapter(makeAccount());
  restarted.onMessage = async (message) => {
    received.push(message);
  };
  await restarted.start();
  expect(received).toHaveLength(2);
  await restarted.stop();
});

test("polls configured peer conversations with the canonical encrypted ID", async () => {
  const fetchedThreadIds: string[] = [];
  let peerLookups = 0;
  const sdkAdapter: XChatSdkAdapterLike = {
    botUserId: "209",
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async (threadId) => {
      fetchedThreadIds.push(threadId);
      return { messages: [] };
    },
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({ data: [] }),
      getConversation: async () => {
        peerLookups += 1;
        return { data: { id: "123-209" } };
      },
    },
    users: {
      getMe: async () => ({ data: { id: "209", username: "bot" } }),
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

  const adapter = createXChatAdapter(makeAccount({ peer_user_ids: ["123"] }));
  await adapter.start();
  await adapter.pollNow();
  expect(fetchedThreadIds).toEqual(["xchat:123:209", "xchat:123:209"]);
  expect(peerLookups).toBe(1);
  await adapter.stop();
});

test("applies startup lookback to conversations discovered after prior state", async () => {
  const state = new XChatPollState("xchat-test");
  state.add("existing-conversation", "existing-message", Date.now(), "1");
  state.save();
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async (threadId) => ({
      messages:
        threadId === "xchat:new-conversation"
          ? [
              makeMessage({
                id: "old-new-conversation-message",
                text: "old",
                conversationId: "new-conversation",
                ageMs: 60 * 60 * 1_000,
              }),
              makeMessage({
                id: "recent-new-conversation-message",
                text: "recent",
                conversationId: "new-conversation",
              }),
            ]
          : [],
    }),
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({
        data: [{ id: "new-conversation" }],
      }),
    },
    users: {
      getMe: async () => ({ data: { id: "bot-user", username: "bot" } }),
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

  const received: string[] = [];
  const adapter = createXChatAdapter(makeAccount());
  adapter.onMessage = async (message) => {
    received.push(message.messageId ?? "");
  };
  await adapter.start();
  expect(received).toEqual(["recent-new-conversation-message"]);
  await adapter.stop();
});

test("keeps polling healthy conversations when one conversation fails", async () => {
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async (threadId) => {
      if (threadId === "xchat:bad-conversation") {
        throw new Error("malformed conversation");
      }
      return {
        messages: [
          makeMessage({
            id: "healthy-message",
            text: "hello",
            conversationId: "healthy-conversation",
          }),
        ],
      };
    },
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({
        data: [{ id: "bad-conversation" }, { id: "healthy-conversation" }],
      }),
    },
    users: {
      getMe: async () => ({ data: { id: "bot-user", username: "bot" } }),
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

  const received: string[] = [];
  const adapter = createXChatAdapter(makeAccount());
  adapter.onMessage = async (message) => {
    received.push(message.messageId ?? "");
  };
  await expect(adapter.start()).resolves.toBeUndefined();
  expect(received).toEqual(["healthy-message"]);
  await adapter.stop();
});

test("starts and schedules a retry when the initial poll is rate limited", async () => {
  const resetAtSeconds = Math.ceil((Date.now() + 4 * 60_000) / 1_000);
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    postMessage: async () => ({ id: "sent" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => {
        throw {
          status: 429,
          headers: new Headers({
            "x-rate-limit-reset": String(resetAtSeconds),
          }),
        };
      },
    },
    users: {
      getMe: async () => ({ data: { id: "bot-user", username: "bot" } }),
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

  const adapter = createXChatAdapter(makeAccount());
  await expect(adapter.start()).resolves.toBeUndefined();
  expect(adapter.isRunning()).toBe(true);
  expect(
    (adapter as unknown as { pollDelayMs: number }).pollDelayMs,
  ).toBeGreaterThan(3 * 60_000);
  await adapter.stop();
});

test("sends text, reactions, and attachments through the encrypted adapter", async () => {
  const sent: unknown[] = [];
  const reactions: unknown[] = [];
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    async postMessage(threadId, message) {
      sent.push({ threadId, message });
      return { id: `sent-${sent.length}` };
    },
    async addReaction(...args) {
      reactions.push(["add", ...args]);
    },
    async removeReaction(...args) {
      reactions.push(["remove", ...args]);
    },
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

  const adapter = createXChatAdapter(makeAccount());
  await adapter.start();
  expect(
    await adapter.sendMessage({
      channel: "xchat",
      chatId: "dm-conversation",
      text: "hello",
    }),
  ).toEqual({ messageId: "sent-1" });

  await adapter.sendDirectReply("dm-conversation", "system reply");
  await adapter.sendDirectReply("dm-conversation", "system reply");

  await adapter.sendMessage({
    channel: "xchat",
    chatId: "dm-conversation",
    text: "",
    targetMessageId: "target",
    reaction: "👍",
  });

  const filePath = join(channelsRoot, "example.txt");
  writeFileSync(filePath, "attachment");
  expect(
    await adapter.sendMessage({
      channel: "xchat",
      chatId: "dm-conversation",
      text: "caption",
      mediaPath: filePath,
      fileName: "example.txt",
    }),
  ).toEqual({ messageId: "sent-3" });

  expect(sent[0]).toEqual({
    threadId: "xchat:dm-conversation",
    message: "hello",
  });
  expect(reactions).toEqual([["add", "xchat:dm-conversation", "target", "👍"]]);
  expect(sent[1]).toEqual({
    threadId: "xchat:dm-conversation",
    message: "system reply",
  });
  expect(sent[2]).toMatchObject({
    threadId: "xchat:dm-conversation",
    message: {
      raw: "caption",
      files: [{ filename: "example.txt" }],
    },
  });
  await adapter.stop();
});

test("shows typing during an X Chat turn and clears it on finish", async () => {
  const typing: string[] = [];
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    startTyping: async (threadId) => {
      typing.push(`start:${threadId}`);
    },
    stopTyping: (conversationId) => {
      typing.push(`stop:${conversationId}`);
    },
    postMessage: async () => ({ id: "sent" }),
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

  const adapter = createXChatAdapter(makeAccount());
  await adapter.start();
  const source = {
    channel: "xchat",
    accountId: "xchat-test",
    chatId: "sender:bot-user",
    chatType: "direct" as const,
    senderId: "sender",
    messageId: "message-1",
    threadId: null,
    agentId: "agent-1",
    conversationId: "conversation-1",
  };
  await adapter.handleTurnLifecycleEvent?.({ type: "queued", source });
  await adapter.handleTurnLifecycleEvent?.({
    type: "processing",
    batchId: "batch-1",
    sources: [source],
  });
  await adapter.handleTurnLifecycleEvent?.({
    type: "finished",
    batchId: "batch-1",
    sources: [source],
    outcome: "completed",
    stopReason: "end_turn",
  });

  expect(typing).toEqual([
    "start:xchat:sender:bot-user",
    "stop:sender:bot-user",
  ]);
  await adapter.stop();
});

test("disconnects the SDK adapter when encryption initialization fails", async () => {
  let disconnected = false;
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "error",
    userName: "bot",
    initialize: async () => {
      throw new Error("incorrect PIN");
    },
    disconnect: async () => {
      disconnected = true;
    },
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

  const adapter = createXChatAdapter(makeAccount());
  await expect(adapter.start()).rejects.toThrow("incorrect PIN");
  expect(disconnected).toBe(true);
  expect(adapter.isRunning()).toBe(false);
});

test("paginates past 50 recent messages during bootstrap", async () => {
  const allMessages = Array.from({ length: 60 }, (_, index) =>
    makeMessage({
      id: `message-${59 - index}`,
      text: `message ${59 - index}`,
      conversationId: "dm-conversation",
      ageMs: index * 100,
    }),
  );
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    async fetchMessages(_threadId, options) {
      const offset = Number(options?.cursor ?? 0);
      const page = allMessages.slice(offset, offset + 50);
      const nextOffset = offset + page.length;
      return {
        messages: page,
        nextCursor:
          nextOffset < allMessages.length ? String(nextOffset) : undefined,
      };
    },
    postMessage: async () => ({ id: "unused" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({ data: [{ id: "dm-conversation" }] }),
    },
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

  const received: string[] = [];
  const adapter = createXChatAdapter(makeAccount());
  adapter.onMessage = async (message) => {
    received.push(message.messageId ?? "");
  };
  await adapter.start();
  expect(received).toHaveLength(60);
  expect(new Set(received).size).toBe(60);
  await adapter.pollNow();
  expect(received).toHaveLength(60);
  await adapter.stop();
});

test("bounds shutdown while a message fetch is blocked", async () => {
  let releaseFetch: (value: { messages: XChatSdkMessageLike[] }) => void =
    () => {};
  const blockedFetch = new Promise<{ messages: XChatSdkMessageLike[] }>(
    (resolve) => {
      releaseFetch = resolve;
    },
  );
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async () => {},
    disconnect: async () => {},
    fetchMessages: async () => blockedFetch,
    postMessage: async () => ({ id: "unused" }),
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: {
      getConversations: async () => ({ data: [{ id: "dm-conversation" }] }),
    },
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

  const adapter = createXChatAdapter(makeAccount());
  const start = adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const startedAt = Date.now();
  await adapter.stop();
  expect(Date.now() - startedAt).toBeLessThan(500);
  releaseFetch({ messages: [] });
  await start;
});

test("does not deliver media after X Chat stops", async () => {
  let handleIncomingMessage:
    | ((
        adapter: unknown,
        threadId: string,
        message: XChatSdkMessageLike,
      ) => Promise<void>)
    | undefined;
  let releaseMedia: () => void = () => {};
  let markMediaStarted: () => void = () => {};
  const mediaStarted = new Promise<void>((resolve) => {
    markMediaStarted = resolve;
  });
  const mediaReleased = new Promise<void>((resolve) => {
    releaseMedia = resolve;
  });
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async (host) => {
      handleIncomingMessage = (
        host as {
          handleIncomingMessage: typeof handleIncomingMessage;
        }
      ).handleIncomingMessage;
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
      getMe: async () => ({ data: {} }),
      getPublicKey: async () => ({ data: [] }),
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

  const received: string[] = [];
  const adapter = createXChatAdapter(makeAccount());
  adapter.onMessage = async (message) => {
    received.push(message.messageId ?? "");
  };
  await adapter.start();
  const message = makeMessage({
    id: "stopping-message",
    text: "stopping",
    conversationId: "dm-conversation",
  });
  message.attachments = [
    {
      type: "image",
      size: 4,
      fetchData: async () => {
        markMediaStarted();
        await mediaReleased;
        return Buffer.from("test");
      },
    },
  ];
  const delivery = handleIncomingMessage?.(
    sdkAdapter,
    "xchat:dm-conversation",
    message,
  );
  await mediaStarted;
  await adapter.stop();
  releaseMedia();
  await delivery;

  expect(received).toEqual([]);
});

test("discovers Message request conversations through the activity stream", async () => {
  const subscriptions: string[] = [];
  let activityFetches = 0;
  let activityConnections = 0;
  let attachmentFetched = false;
  let streamCancelled = false;
  let handleIncomingMessage:
    | ((
        adapter: unknown,
        threadId: string,
        message: XChatSdkMessageLike,
      ) => Promise<void>)
    | undefined;
  let releaseActivityStream: () => void = () => {};
  const activityStreamDone = new Promise<void>((resolve) => {
    releaseActivityStream = resolve;
  });
  const requestMessage = makeMessage({
    id: "request-message",
    text: "message request",
    conversationId: "request-conversation",
  });
  requestMessage.attachments = [
    {
      type: "image",
      name: "unpaired.png",
      mimeType: "image/png",
      size: 4,
      fetchData: async () => {
        attachmentFetched = true;
        return Buffer.from("test");
      },
    },
  ];
  const sdkAdapter: XChatSdkAdapterLike = {
    botUserId: "bot-user",
    cryptoStatus: "ready",
    userName: "bot",
    initialize: async (host) => {
      handleIncomingMessage = (
        host as {
          handleIncomingMessage: typeof handleIncomingMessage;
        }
      ).handleIncomingMessage;
    },
    disconnect: async () => {},
    async fetchMessages(threadId) {
      activityFetches += 1;
      return threadId === "xchat:request-conversation"
        ? { messages: [requestMessage] }
        : { messages: [] };
    },
    async handleIncomingEvent(event) {
      await handleIncomingMessage?.(
        sdkAdapter,
        `xchat:${event.conversationId}`,
        requestMessage,
      );
      return requestMessage;
    },
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
    activity: {
      async createSubscription(body) {
        subscriptions.push(body.eventType);
        return {};
      },
    },
  };
  const activityClient: XChatApiClientLike = {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user" } }),
      getPublicKey: async () => ({ data: [{}] }),
    },
    stream: {
      async activity() {
        activityConnections += 1;
        if (activityConnections === 1) {
          throw {
            data: {
              errors: [
                {
                  message:
                    "Stream is not authorized to use backfill_minutes parameter",
                },
              ],
            },
          };
        }
        return {
          close() {},
          reader: {
            async cancel() {
              streamCancelled = true;
              releaseActivityStream();
            },
          },
          async *[Symbol.asyncIterator]() {
            yield {
              data: {
                eventType: "chat.received",
                payload: {
                  id: "request-message",
                  conversation_id: "request-conversation",
                  sender_id: "sender-user",
                  encoded_event: "encrypted-message",
                },
              },
            };
            yield {
              data: {
                eventType: "chat.received",
                payload: {
                  id: "request-message",
                  conversation_id: "request-conversation",
                  sender_id: "sender-user",
                  encoded_event: "encrypted-message",
                },
              },
            };
            await activityStreamDone;
          },
        };
      },
    },
  };
  __testOverrideXChatRuntime({
    sdk: async () => ({ createXchatAdapter: () => sdkAdapter }),
    xdk: async () => ({
      Client: class {
        chat: XChatApiClientLike["chat"];
        users: XChatApiClientLike["users"];
        activity?: XChatApiClientLike["activity"];
        stream?: XChatApiClientLike["stream"];

        constructor(config: { bearerToken?: string }) {
          const client = config.bearerToken ? activityClient : apiClient;
          this.chat = client.chat;
          this.users = client.users;
          this.activity = client.activity;
          this.stream = client.stream;
        }
      },
    }),
  });

  const received: string[] = [];
  const account = makeAccount({ activity_token: "app-bearer" });
  account.dmPolicy = "pairing";
  const adapter = createXChatAdapter(account);
  adapter.onMessage = async (message) => {
    received.push(message.messageId ?? "");
  };
  await adapter.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await adapter.pollNow();

  expect(subscriptions).toEqual(["chat.received", "chat.conversation.join"]);
  expect(received).toEqual(["request-message"]);
  expect(activityFetches).toBe(1);
  expect(attachmentFetched).toBe(false);
  expect(activityConnections).toBe(2);
  await adapter.stop();
  expect(streamCancelled).toBe(true);
});
