import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
} from "@/channels/accounts";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
} from "@/channels/pairing";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
  setRouteInMemory,
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";
import { ChannelGateway } from "./gateway-core";
import {
  FakeClient,
  makeDelivery,
  makeHooks,
  makeSource,
  makeStreamDelta,
  makeTurnFinished,
} from "./gateway-test-support";

const createConversation = mock(async () => ({ id: "conv-telegram" }));

mock.module("@/backend/api/client", () => ({
  getServerUrl: () => "https://api.letta.com",
  getClient: async () => ({
    conversations: {
      create: createConversation,
    },
  }),
}));

describe("telegram channel registry", () => {
  function resetState(): void {
    clearChannelAccountStores();
    clearAllRoutes();
    clearPairingStores();
    clearTargetStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
    createConversation.mockReset();
    createConversation.mockResolvedValue({ id: "conv-telegram" });
  }

  function createInboundMessage(
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "telegram",
      accountId: "telegram-bot",
      chatId: "-100123",
      senderId: "user-1",
      senderName: "Cameron",
      chatLabel: "Void Cafe",
      text: "hello topic",
      timestamp: Date.now(),
      messageId: "msg-1",
      threadId: "42",
      chatType: "channel",
      ...overrides,
    };
  }

  function createAdapter(
    replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
      threadId?: string | null;
    }> = [],
  ): ChannelAdapter {
    return {
      id: "telegram:telegram-bot",
      channelId: "telegram",
      accountId: "telegram-bot",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "outbound-1" }),
      sendDirectReply: async (chatId, text, options) => {
        replies.push({
          chatId,
          text,
          replyToMessageId: options?.replyToMessageId,
          threadId: options?.threadId,
        });
      },
    };
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});
  });

  afterEach(async () => {
    const { getChannelRegistry } = await import("@/channels/registry");
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    resetState();
  });

  test.each(["end_turn", "cancelled", "llm_api_error"])(
    "/new cannot overtake an approval waiting behind progress after %s",
    async (stopReason) => {
      const { ChannelRegistry } = await import("@/channels/registry");
      const registry = new ChannelRegistry();
      const replies: Array<{ chatId: string; text: string }> = [];
      const adapter = createAdapter(replies);
      const progressStarted = Promise.withResolvers<void>();
      const releaseProgress = Promise.withResolvers<void>();
      const finished = Promise.withResolvers<void>();
      adapter.handleTurnProgressEvent = async () => {
        progressStarted.resolve();
        await releaseProgress.promise;
      };
      adapter.handleTurnLifecycleEvent = async (event) => {
        if (event.type === "finished") finished.resolve();
      };
      adapter.handleControlRequestEvent = async () => {};
      registry.registerAdapter(adapter);
      const client = new FakeClient();
      const gateway = new ChannelGateway(
        client,
        makeHooks({
          onProgress: (event) => registry.dispatchTurnProgressEvent(event),
          onLifecycle: (event) => registry.dispatchTurnLifecycleEvent(event),
          onControlRequest: (event) =>
            registry.registerPendingControlRequest(event),
        }).hooks,
      );
      registry.setRuntimeBusyHandler((runtime) =>
        gateway.isRuntimeBusy(runtime),
      );
      registry.setMessageHandler(() => {});
      registry.setReady();
      setRouteInMemory("telegram", {
        accountId: "telegram-bot",
        chatId: "-100123",
        threadId: "42",
        chatType: "channel",
        agentId: "agent-1",
        conversationId: "conv-1",
        enabled: true,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      try {
        await gateway.submit(
          makeDelivery({
            sources: [
              makeSource({
                accountId: "telegram-bot",
                chatId: "-100123",
                threadId: "42",
              }),
            ],
          }),
        );
        client.emit(
          makeStreamDelta({
            message_type: "reasoning_message",
            run_id: "run-1",
          }),
        );
        await progressStarted.promise;
        client.emit({
          type: "control_request",
          request_id: "ctrl-delayed",
          agent_id: "agent-1",
          conversation_id: "conv-1",
          request: {
            subtype: "can_use_tool",
            tool_name: "Bash",
            input: { command: "ls" },
            tool_call_id: "call-1",
            permission_suggestions: [],
            blocked_path: null,
          },
        });
        client.emit(makeTurnFinished(stopReason));
        expect(registry.hasPendingControlRequest("ctrl-delayed")).toBe(false);
        await adapter.onMessage?.(createInboundMessage({ text: "/new" }));
        expect(
          getRoute("telegram", "-100123", "telegram-bot", "42")?.conversationId,
        ).toBe("conv-1");
        expect(createConversation).not.toHaveBeenCalled();
        expect(replies.at(-1)?.text).toContain("/cancel");
        releaseProgress.resolve();
        await finished.promise;
        // The gateway hands the guard over to the registry without an idle gap.
        expect(registry.hasPendingControlRequest("ctrl-delayed")).toBe(true);
        await adapter.onMessage?.(createInboundMessage({ text: "/new" }));
        expect(createConversation).not.toHaveBeenCalled();
        registry.clearPendingControlRequest("ctrl-delayed");
        await adapter.onMessage?.(createInboundMessage({ text: "/new" }));
        expect(createConversation).toHaveBeenCalledTimes(1);
        expect(
          getRoute("telegram", "-100123", "telegram-bot", "42")?.conversationId,
        ).toBe("conv-telegram");
      } finally {
        releaseProgress.resolve();
        await finished.promise;
        registry.clearPendingControlRequest("ctrl-delayed");
        gateway.close();
      }
    },
  );

  test("mention-only Telegram groups ignore ambient messages", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        groupMode: "mention-only",
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage({ isMention: false }));

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toBeNull();
    expect(deliveries).toHaveLength(0);
  });

  test("mention-only Telegram groups route explicit mentions", async () => {
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "telegram",
        accountId: "telegram-bot",
        enabled: true,
        token: "telegram-token",
        dmPolicy: "pairing",
        allowedUsers: [],
        groupMode: "mention-only",
        binding: { agentId: "agent-1", conversationId: null },
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage({ isMention: true }));

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toMatchObject(
      {
        accountId: "telegram-bot",
        agentId: "agent-1",
      },
    );
    expect(deliveries).toHaveLength(1);
  });

  afterAll(() => {
    mock.restore();
  });

  test("auto-creates a route per Telegram forum topic for bound group traffic", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage());

    expect(createConversation).toHaveBeenCalledTimes(1);
    expect(createConversation).toHaveBeenCalledWith(
      {
        agent_id: "agent-1",
        summary: "Topic in Void Cafe: hello topic",
      },
      undefined,
    );
    expect(getRoute("telegram", "-100123", "telegram-bot", "42")).toMatchObject(
      {
        accountId: "telegram-bot",
        chatId: "-100123",
        chatType: "channel",
        threadId: "42",
        agentId: "agent-1",
        conversationId: "conv-telegram",
      },
    );
    expect(deliveries).toHaveLength(1);
  });

  test("keeps Telegram direct messages on the pairing route and replies inside private topics", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const replies: Array<{
      chatId: string;
      text: string;
      replyToMessageId?: string;
      threadId?: string | null;
    }> = [];
    const adapter = createAdapter(replies);
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "123",
        chatLabel: undefined,
        chatType: "direct",
        threadId: "175380",
        messageId: "77",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("telegram", "123", "telegram-bot")).toBeNull();
    expect(deliveries).toHaveLength(0);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      chatId: "123",
      replyToMessageId: "77",
      threadId: "175380",
    });
    expect(replies[0]?.text).toContain("Pairing code:");
  });

  test("routes Telegram private topic messages through the root direct route", async () => {
    __testOverrideLoadPairingStore(() => ({
      pending: [],
      approved: [
        {
          accountId: "telegram-bot",
          senderId: "user-1",
          senderName: "Test User",
          approvedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    }));

    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "123",
        chatLabel: undefined,
        chatType: "direct",
        threadId: "175380",
        messageId: "77",
        text: "hello private topic",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(getRoute("telegram", "123", "telegram-bot", "175380")).toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      route: {
        accountId: "telegram-bot",
        chatId: "123",
        chatType: "direct",
        threadId: null,
        agentId: "agent-1",
        conversationId: "default",
      },
      turnSources: [
        {
          channel: "telegram",
          accountId: "telegram-bot",
          chatId: "123",
          chatType: "direct",
          messageId: "77",
          threadId: "175380",
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });
  });

  test("does not bypass a disabled exact Telegram private topic route", async () => {
    __testOverrideLoadPairingStore(() => ({
      pending: [],
      approved: [
        {
          accountId: "telegram-bot",
          senderId: "user-1",
          senderName: "Test User",
          approvedAt: "2026-07-03T00:00:00.000Z",
        },
      ],
    }));

    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: null,
      agentId: "agent-root",
      conversationId: "conv-root",
      enabled: true,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });
    setRouteInMemory("telegram", {
      accountId: "telegram-bot",
      chatId: "123",
      chatType: "direct",
      threadId: "175380",
      agentId: "agent-topic",
      conversationId: "conv-topic",
      enabled: false,
      createdAt: "2026-07-03T00:00:00.000Z",
      updatedAt: "2026-07-03T00:00:00.000Z",
    });

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "123",
        chatLabel: undefined,
        chatType: "direct",
        threadId: "175380",
        messageId: "77",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(0);
  });
});
