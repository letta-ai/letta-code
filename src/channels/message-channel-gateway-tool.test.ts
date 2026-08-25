import { afterEach, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelAdapter } from "@/channels/types";
import { makeSource } from "./gateway-test-support";
import { buildGatewayMessageChannelTool } from "./message-channel-gateway-tool";

afterEach(async () => {
  await getChannelRegistry()?.stopAll();
  clearChannelAccountStores();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
});

test("does not build MessageChannel without an eligible route or proactive account", async () => {
  expect(await buildGatewayMessageChannelTool([])).toBeNull();
});

test("withholds relay guidance for two Slack threads on the same account", async () => {
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  upsertChannelAccount("slack", {
    channel: "slack",
    accountId: "account-1",
    displayName: "Slack",
    enabled: true,
    dmPolicy: "pairing",
    replyMode: "relay",
    allowedUsers: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    mode: "socket",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    agentId: "agent-1",
    defaultPermissionMode: "standard",
  });

  const tool = await buildGatewayMessageChannelTool([
    makeSource({
      accountId: "account-1",
      chatId: "C123",
      threadId: "thread-1",
    }),
    makeSource({
      accountId: "account-1",
      chatId: "C123",
      threadId: "thread-2",
    }),
  ]);

  expect(tool?.description).not.toContain("uses automatic relay");
});

test("builds proactive Slack for a fresh conversation owned by the account agent", async () => {
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  const registry = new ChannelRegistry();
  const adapter: ChannelAdapter = {
    id: "slack:account-1",
    channelId: "slack",
    accountId: "account-1",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "unused" }),
    sendDirectReply: async () => {},
  };
  registry.registerAdapter(adapter);
  upsertChannelAccount("slack", {
    channel: "slack",
    accountId: "account-1",
    displayName: "Slack",
    enabled: true,
    dmPolicy: "pairing",
    allowedUsers: [],
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    mode: "socket",
    botToken: "xoxb-test",
    appToken: "xapp-test",
    agentId: "agent-1",
    defaultPermissionMode: "standard",
  });

  const tool = await buildGatewayMessageChannelTool([], {
    agent_id: "agent-1",
    conversation_id: "conv-schedule-1",
  });
  expect(tool).not.toBeNull();
  expect(tool?.description).not.toContain(
    "currently scoped to a routed external channel turn",
  );

  await expect(
    buildGatewayMessageChannelTool([], {
      agent_id: "agent-other",
      conversation_id: "conv-schedule-2",
    }),
  ).resolves.toBeNull();
});
