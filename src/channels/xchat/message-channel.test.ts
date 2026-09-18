import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testOverrideChannelsRoot } from "@/channels/config";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";
import type { CustomChannelAccount } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";
import { createXChatAdapter } from "./adapter";
import {
  __testOverrideXChatRuntime,
  type XChatApiClientLike,
  type XChatSdkAdapterLike,
} from "./runtime";

let channelsRoot: string;

beforeEach(() => {
  channelsRoot = mkdtempSync(join(tmpdir(), "letta-xchat-gateway-"));
  __testOverrideChannelsRoot(channelsRoot);
});

afterEach(async () => {
  await getChannelRegistry()?.stopAll();
  clearAllRoutes();
  __testOverrideXChatRuntime(null);
  __testOverrideChannelsRoot(null);
  rmSync(channelsRoot, { recursive: true, force: true });
});

test("routes MessageChannel through the running X Chat adapter", async () => {
  const sent: unknown[] = [];
  const sdkAdapter: XChatSdkAdapterLike = {
    cryptoStatus: "ready",
    userName: "co",
    initialize: async () => {},
    fetchMessages: async () => ({ messages: [] }),
    async postMessage(threadId, message) {
      sent.push({ threadId, message });
      return { id: "xchat-sent-1" };
    },
    addReaction: async () => {},
    removeReaction: async () => {},
  };
  const apiClient: XChatApiClientLike = {
    chat: { getConversations: async () => ({ data: [] }) },
    users: {
      getMe: async () => ({ data: { id: "bot-user", username: "co" } }),
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

  const account: CustomChannelAccount = {
    channel: "xchat",
    accountId: "xchat-account",
    enabled: true,
    dmPolicy: "open",
    allowedUsers: [],
    config: {
      bot_token: "xcbot_test",
      pin: "1234",
      poll_interval_ms: 60_000,
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const adapter = createXChatAdapter(account);
  await adapter.start();

  const registry = new ChannelRegistry();
  registry.registerAdapter(adapter);
  setRouteInMemory("xchat", {
    accountId: account.accountId,
    chatId: "dm-conversation",
    chatType: "direct",
    threadId: null,
    agentId: "agent-1",
    conversationId: "default",
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });

  const result = await message_channel({
    action: "send",
    channel: "xchat",
    chat_id: "dm-conversation",
    message: "Hello from Letta",
    parentScope: {
      agentId: "agent-1",
      conversationId: "default",
    },
  });

  expect(result).toBe("Message sent to X Chat (message_id: xchat-sent-1)");
  expect(sent).toEqual([
    {
      threadId: "xchat:dm-conversation",
      message: "Hello from Letta",
    },
  ]);
});
