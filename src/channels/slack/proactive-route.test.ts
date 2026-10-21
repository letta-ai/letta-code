import { afterEach, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRouteRaw,
  setRouteInMemory,
} from "@/channels/routing";
import {
  bindProactiveSlackThreadRoute,
  createProactiveSlackTransport,
} from "./proactive-route";

const params = {
  accountId: "account-1",
  chatId: "C123",
  rootMessageId: "1712800000.000100",
  agentId: "agent-1",
  conversationId: "conv-schedule-1",
};

afterEach(() => {
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

function installRouteStorageOverrides(): void {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
}

test("binds a proactive Slack root to its occurrence conversation", () => {
  installRouteStorageOverrides();

  bindProactiveSlackThreadRoute(params);

  expect(
    getRouteRaw("slack", params.chatId, params.accountId, params.rootMessageId),
  ).toMatchObject({
    accountId: params.accountId,
    chatId: params.chatId,
    chatType: "channel",
    threadId: params.rootMessageId,
    agentId: params.agentId,
    conversationId: params.conversationId,
    enabled: true,
    outboundEnabled: true,
  });
});

test("keeps an idempotent binding and refuses to overwrite a conflict", () => {
  installRouteStorageOverrides();
  bindProactiveSlackThreadRoute(params);
  expect(() => bindProactiveSlackThreadRoute(params)).not.toThrow();

  clearAllRoutes();
  setRouteInMemory("slack", {
    accountId: params.accountId,
    chatId: params.chatId,
    chatType: "channel",
    threadId: params.rootMessageId,
    agentId: "agent-other",
    conversationId: "conv-other",
    enabled: true,
    createdAt: "2026-08-13T00:00:00.000Z",
  });

  expect(() => bindProactiveSlackThreadRoute(params)).toThrow(
    "is already routed to agent-other/conv-other",
  );
  expect(
    getRouteRaw("slack", params.chatId, params.accountId, params.rootMessageId),
  ).toMatchObject({
    agentId: "agent-other",
    conversationId: "conv-other",
  });
});

test("rolls back an in-memory binding when persistence fails", () => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {
    throw new Error("disk unavailable");
  });

  expect(() => bindProactiveSlackThreadRoute(params)).toThrow(
    "disk unavailable",
  );
  expect(
    getRouteRaw("slack", params.chatId, params.accountId, params.rootMessageId),
  ).toBeUndefined();

  __testOverrideSaveRoutes(() => {});
  expect(() => bindProactiveSlackThreadRoute(params)).not.toThrow();
});

test("reports a sent root as an error when its route cannot be persisted", async () => {
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {
    throw new Error("disk unavailable");
  });
  const sendMessage = mock(async () => ({ messageId: params.rootMessageId }));
  const transport = createProactiveSlackTransport({
    adapter: {
      id: "slack:account-1",
      channelId: "slack",
      accountId: params.accountId,
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage,
      sendDirectReply: async () => {},
    },
    accountId: params.accountId,
    target: {
      chatId: params.chatId,
      chatType: "channel",
      threadId: null,
    },
    agentId: params.agentId,
    conversationId: params.conversationId,
  });

  await expect(
    transport.sendMessage({
      channel: "slack",
      accountId: params.accountId,
      chatId: params.chatId,
      text: "hello",
      agentId: params.agentId,
      conversationId: params.conversationId,
    }),
  ).rejects.toThrow(
    `Slack accepted message ${params.rootMessageId}, but its thread route could not be persisted: disk unavailable`,
  );
  expect(sendMessage).toHaveBeenCalledTimes(1);
  expect(
    getRouteRaw("slack", params.chatId, params.accountId, params.rootMessageId),
  ).toBeUndefined();
});
