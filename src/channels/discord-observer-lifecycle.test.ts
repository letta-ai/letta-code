import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import type { ChannelInboundDelivery } from "@/channels/registry-handlers";
import type {
  ChannelAdapter,
  DiscordChannelAccount,
  InboundChannelMessage,
} from "@/channels/types";

const ACCOUNT_ID = "discord-observer";

function createObserverAccount(options: {
  targetAgentId: string;
  maxMessages?: number;
}): DiscordChannelAccount {
  return {
    channel: "discord",
    accountId: ACCOUNT_ID,
    enabled: true,
    token: "discord-token",
    agentId: "agent-chat",
    defaultPermissionMode: "standard",
    dmPolicy: "pairing",
    allowedUsers: [],
    observer: {
      guildId: "guild-observed",
      targets: [{ agentId: options.targetAgentId, conversationId: "default" }],
      maxMessages: options.maxMessages ?? 10,
      flushIntervalMs: 60_000,
    },
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
}

function createAdapter(): ChannelAdapter {
  return {
    id: `discord:${ACCOUNT_ID}`,
    channelId: "discord",
    accountId: ACCOUNT_ID,
    name: "Discord",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "outbound" }),
    sendDirectReply: async () => {},
  };
}

function createMessage(text: string, messageId: string): InboundChannelMessage {
  return {
    channel: "discord",
    accountId: ACCOUNT_ID,
    chatId: "channel-observed",
    guildId: "guild-observed",
    senderId: "user-1",
    senderName: "Cameron",
    text,
    timestamp: Date.now(),
    messageId,
    threadId: null,
    chatType: "channel",
    isMention: false,
  };
}

describe("Discord observer lifecycle", () => {
  beforeEach(() => {
    clearChannelAccountStores();
    __testOverrideSaveChannelAccounts(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) await registry.stopAll();
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  test("process shutdown waits for final batch gateway acceptance", async () => {
    __testOverrideLoadChannelAccounts(() => [
      createObserverAccount({ targetAgentId: "agent-alpha" }),
    ]);
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);
    let releaseDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const deliveries: ChannelInboundDelivery[] = [];
    registry.setMessageHandler(async (delivery) => {
      deliveries.push(delivery);
      await deliveryGate;
    });
    registry.setReady();

    await adapter.onMessage?.(createMessage("pending observation", "msg-1"));
    let stopped = false;
    const shutdown = registry.stopAll().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);

    expect(deliveries).toHaveLength(1);
    expect(stopped).toBe(false);
    releaseDelivery();
    await shutdown;
    expect(stopped).toBe(true);
  });

  test("stopping an observer account cancels content pending for old targets", async () => {
    __testOverrideLoadChannelAccounts(() => [
      createObserverAccount({ targetAgentId: "agent-old" }),
    ]);
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);
    const deliveries: ChannelInboundDelivery[] = [];
    registry.setMessageHandler((delivery) => deliveries.push(delivery));
    registry.setReady();

    await adapter.onMessage?.(createMessage("private pending text", "msg-1"));
    expect(await registry.stopChannelAccount("discord", ACCOUNT_ID)).toBe(true);

    expect(deliveries).toHaveLength(0);
  });

  test("changing targets cancels the old window before delivering the new one", async () => {
    __testOverrideLoadChannelAccounts(() => [
      createObserverAccount({ targetAgentId: "agent-old" }),
    ]);
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);
    const deliveries: ChannelInboundDelivery[] = [];
    registry.setMessageHandler((delivery) => deliveries.push(delivery));
    registry.setReady();

    await adapter.onMessage?.(createMessage("old private text", "msg-old"));
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(() => [
      createObserverAccount({
        targetAgentId: "agent-new",
        maxMessages: 1,
      }),
    ]);
    await adapter.onMessage?.(createMessage("new visible text", "msg-new"));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.route.agentId).toBe("agent-new");
    expect(deliveries[0]?.content).toContain("new visible text");
    expect(deliveries[0]?.content).not.toContain("old private text");
  });
});
