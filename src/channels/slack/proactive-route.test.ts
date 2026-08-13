import { afterEach, expect, test } from "bun:test";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRouteRaw,
  setRouteInMemory,
} from "@/channels/routing";
import { bindProactiveSlackThreadRoute } from "./proactive-route";

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
