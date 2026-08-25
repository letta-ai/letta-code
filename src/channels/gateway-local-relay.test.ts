import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { ChannelGateway } from "@/channels/gateway-core";
import {
  createLocalChannelGatewayHooks,
  relayLocalAssistantText,
} from "@/channels/gateway-local";
import { createMessageChannelIdempotencyScope } from "@/channels/message-channel-idempotency";
import type { MessageChannelArgs } from "@/channels/message-channel-types";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import { clearAllRoutes, setRouteInMemory } from "@/channels/routing";
import {
  createChannelAccountLive,
  getChannelAccountSnapshot,
  updateChannelAccountLive,
} from "@/channels/service";
import type { ChannelAdapter, SlackChannelAccount } from "@/channels/types";
import { message_channel } from "@/tools/impl/message-channel";
import {
  FakeClient,
  makeDelivery,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
} from "./gateway-test-support";

const SOURCE = makeSource({
  channel: "slack",
  accountId: "account-1",
  chatId: "C123",
});

function setup(replyMode: "tool" | "relay") {
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  createChannelAccountLive(
    "slack",
    {
      enabled: true,
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      dmPolicy: "open",
      replyMode,
      agentId: SOURCE.agentId,
    },
    { accountId: SOURCE.accountId },
  );

  const sendMessage = mock(async () => ({ messageId: "message-1" }));
  const adapter: ChannelAdapter = {
    id: "slack:account-1",
    channelId: "slack",
    accountId: "account-1",
    name: "Slack",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage,
    sendDirectReply: async () => {},
  };
  const registry = new ChannelRegistry();
  registry.registerAdapter(adapter);
  setRouteInMemory("slack", {
    accountId: SOURCE.accountId,
    chatId: SOURCE.chatId,
    chatType: "channel",
    threadId: SOURCE.threadId,
    agentId: SOURCE.agentId,
    conversationId: SOURCE.conversationId,
    enabled: true,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  });
  return sendMessage;
}

describe("local automatic channel relay", () => {
  beforeEach(() => {
    clearChannelAccountStores();
  });

  afterEach(async () => {
    await getChannelRegistry()?.stopAll();
    clearAllRoutes();
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test("old accounts default to tool mode while stored relay mode round-trips in snake_case", () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "legacy-tool",
        enabled: false,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        agentId: null,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      } as unknown as SlackChannelAccount,
      {
        channel: "slack",
        accountId: "stored-relay",
        enabled: false,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        dmPolicy: "pairing",
        reply_mode: "relay",
        allowedUsers: [],
        agentId: null,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      } as unknown as SlackChannelAccount,
    ]);

    expect(getChannelAccountSnapshot("slack", "legacy-tool")?.replyMode).toBe(
      "tool",
    );
    expect(getChannelAccountSnapshot("slack", "stored-relay")?.replyMode).toBe(
      "relay",
    );

    let savedAccounts: Array<Record<string, unknown>> = [];
    __testOverrideSaveChannelAccounts((_channelId, accounts) => {
      savedAccounts = accounts as unknown as Array<Record<string, unknown>>;
    });
    updateChannelAccountLive("slack", "stored-relay", {
      replyMode: "relay",
    });

    const saved = savedAccounts.find(
      (account) => account.accountId === "stored-relay",
    );
    expect(saved?.reply_mode).toBe("relay");
    expect(saved).not.toHaveProperty("replyMode");
  });

  test.each([
    ["relay", 1],
    ["tool", 0],
  ] as const)(
    "actual local gateway hooks deliver completed text in %s mode",
    async (replyMode, expectedSends) => {
      const sendMessage = setup(replyMode);
      const registry = getChannelRegistry();
      if (!registry) throw new Error("registry missing");
      const client = new FakeClient();
      const gateway = new ChannelGateway(
        client,
        createLocalChannelGatewayHooks(registry),
      );

      await gateway.submit(makeDelivery({ sources: [SOURCE] }));
      client.emit(
        makeStreamDelta({
          message_type: "assistant_message",
          id: "gateway-boundary-assistant",
          content: "gateway boundary reply",
        }),
      );
      client.emit(makeTurnFinished("end_turn"));
      await Bun.sleep(0);

      expect(sendMessage).toHaveBeenCalledTimes(expectedSends);
      if (expectedSends === 1) {
        expect(sendMessage).toHaveBeenCalledWith(
          expect.objectContaining({ text: "gateway boundary reply" }),
        );
      }
      gateway.close();
    },
  );

  test("sends completed assistant text only for relay accounts", async () => {
    const relaySend = setup("relay");
    await relayLocalAssistantText({
      text: "automatic reply",
      sources: [SOURCE],
      idempotencyScope: createMessageChannelIdempotencyScope(),
    });
    expect(relaySend).toHaveBeenCalledTimes(1);
    expect(relaySend).toHaveBeenCalledWith(
      expect.objectContaining({ text: "automatic reply" }),
    );

    await getChannelRegistry()?.stopAll();
    clearAllRoutes();
    clearChannelAccountStores();
    const toolSend = setup("tool");
    await relayLocalAssistantText({
      text: "must stay internal",
      sources: [SOURCE],
      idempotencyScope: createMessageChannelIdempotencyScope(),
    });
    expect(toolSend).not.toHaveBeenCalled();
  });

  test("suppresses relay text already sent explicitly in the same turn", async () => {
    const sendMessage = setup("relay");
    const idempotencyScope = createMessageChannelIdempotencyScope();
    const args: MessageChannelArgs = {
      action: "send",
      channel: "slack",
      chat_id: SOURCE.chatId,
      accountId: SOURCE.accountId,
      message: "same final reply",
      parentScope: {
        agentId: SOURCE.agentId,
        conversationId: SOURCE.conversationId,
      },
      channelTurnSources: [SOURCE],
    };

    await message_channel(args, idempotencyScope);
    await relayLocalAssistantText({
      text: "  same final reply  ",
      sources: [SOURCE],
      idempotencyScope,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});
