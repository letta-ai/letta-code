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
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
} from "@/channels/targets";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";
import {
  createStartedSlackAdapter,
  installSlackAdapterTestHooks,
  resolveSlackThreadHistoryMock,
  resolveSlackThreadStarterMock,
} from "./slack/adapter-test-harness";

installSlackAdapterTestHooks();

const createConversation = mock(async () => ({ id: "conv-slack" }));

function createPage(items: unknown[]) {
  return {
    getPaginatedItems: () => items,
  };
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return String(content);
  return content
    .map((part) => {
      if (part && typeof part === "object" && "text" in part) {
        return String((part as { text?: unknown }).text ?? "");
      }
      return JSON.stringify(part);
    })
    .join("\n");
}

const listConversationMessages = mock(
  async (_conversationId: string, _body?: unknown, _options?: unknown) =>
    createPage([{ id: "msg-existing", message_type: "user_message" }]),
);

mock.module("@/backend/api/client", () => ({
  getServerUrl: () => "https://api.letta.com",
  getClient: async () => ({
    conversations: {
      create: createConversation,
      messages: {
        list: listConversationMessages,
      },
    },
  }),
}));

describe("slack channel registry", () => {
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
    createConversation.mockResolvedValue({ id: "conv-slack" });
    listConversationMessages.mockReset();
    listConversationMessages.mockResolvedValue(
      createPage([{ id: "msg-existing", message_type: "user_message" }]),
    );
  }

  function createInboundMessage(
    overrides: Partial<InboundChannelMessage> = {},
  ): InboundChannelMessage {
    return {
      channel: "slack",
      accountId: "slack-bot",
      chatId: "C123",
      senderId: "U123",
      senderName: "Cameron",
      text: "thread update",
      timestamp: Date.now(),
      messageId: "1712800000.000200",
      threadId: "1712790000.000050",
      chatType: "channel",
      isMention: false,
      ...overrides,
    };
  }

  function createAdapter(): ChannelAdapter {
    return {
      id: "slack:slack-bot",
      channelId: "slack",
      accountId: "slack-bot",
      name: "Slack",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "outbound-1" }),
      sendDirectReply: async () => {},
    };
  }

  beforeEach(() => {
    resetState();
    __testOverrideLoadChannelAccounts(() => [
      {
        channel: "slack",
        accountId: "slack-bot",
        enabled: true,
        mode: "socket",
        botToken: "xoxb-test-token",
        appToken: "xapp-test-token",
        agentId: "agent-1",
        defaultPermissionMode: "unrestricted",
        dmPolicy: "open",
        allowedUsers: [],
        listenMode: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);
    __testOverrideSaveChannelAccounts(() => {});
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
    __testOverrideLoadTargetStore(() => null);
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

  afterAll(() => {
    mock.restore();
  });

  test("listen mode delivers unmentioned thread activity without outbound route access", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: Array<{ turnSources?: unknown[] }> = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage());

    expect(createConversation).toHaveBeenCalledTimes(1);
    const route = getRoute("slack", "C123", "slack-bot", "1712790000.000050");
    expect(route).toEqual(expect.objectContaining({ outboundEnabled: false }));
    expect(route?.bootstrapUserMessageSeenAt).toBeUndefined();
    expect(listConversationMessages).not.toHaveBeenCalled();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.turnSources).toEqual([
      expect.objectContaining({
        channel: "slack",
        accountId: "slack-bot",
        chatId: "C123",
        threadId: "1712790000.000050",
        messageId: "1712800000.000200",
        agentId: "agent-1",
        conversationId: "conv-slack",
      }),
    ]);
    expect(
      registry.getRouteForScope(
        "slack",
        "C123",
        "agent-1",
        "conv-slack",
        "slack-bot",
      ),
    ).toBeNull();
  });

  test("persisted orphan Slack thread route recovers formatted bootstrap context once", async () => {
    const nonUserMessages = [
      { id: "summary-1", message_type: "summary_message" },
      { id: "assistant-1", message_type: "assistant_message" },
    ];
    listConversationMessages
      .mockImplementationOnce(async (_conversationId, body) => {
        const requestedTypes =
          (body as { include_return_message_types?: string[] })
            .include_return_message_types ?? [];
        return createPage(
          requestedTypes.length === 0
            ? nonUserMessages
            : nonUserMessages.filter((message) =>
                requestedTypes.includes(message.message_type),
              ),
        );
      })
      .mockResolvedValueOnce(
        createPage([{ id: "msg-recovered", message_type: "user_message" }]),
      );
    __testOverrideLoadRoutes(() => [
      {
        accountId: "slack-bot",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-recovered",
        enabled: true,
        outboundEnabled: true,
        createdAt: "2026-04-11T00:00:00.000Z",
        updatedAt: "2026-04-11T00:00:00.000Z",
      },
    ]);

    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = await createStartedSlackAdapter({
      accountId: "slack-bot",
      agentId: "agent-1",
      defaultPermissionMode: "unrestricted",
      dmPolicy: "open",
      allowedUsers: [],
    });
    registry.registerAdapter(adapter);

    const deliveries: Array<{ content: unknown; turnSources?: unknown[] }> = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    resolveSlackThreadStarterMock.mockResolvedValueOnce({
      text: "Original root problem statement",
      userId: "U111",
      ts: "1712790000.000050",
      attachments: [
        {
          id: "FROOT",
          name: "root-screenshot.png",
          mimeType: "image/png",
          kind: "image",
          localPath: "/tmp/root-screenshot.png",
        },
      ],
    });
    resolveSlackThreadHistoryMock.mockResolvedValueOnce([
      {
        text: "Prior human investigation notes",
        userId: "U222",
        ts: "1712795000.000060",
      },
    ]);

    await adapter.onMessage?.(
      createInboundMessage({
        text: "bump",
        messageId: "1712800001.000300",
      }),
    );

    expect(createConversation).not.toHaveBeenCalled();
    expect(listConversationMessages).toHaveBeenCalledTimes(1);
    expect(listConversationMessages.mock.calls[0]?.[0]).toBe("conv-recovered");
    expect(listConversationMessages.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        limit: 1,
        order: "desc",
        include_return_message_types: ["user_message"],
        agent_id: "agent-1",
      }),
    );
    expect(
      getRoute("slack", "C123", "slack-bot", "1712790000.000050")
        ?.bootstrapUserMessageSeenAt,
    ).toBeUndefined();
    const recoveredContent = contentText(deliveries[0]?.content);
    expect(recoveredContent).toContain("Original root problem statement");
    expect(recoveredContent).toContain("Prior human investigation notes");
    expect(recoveredContent).toContain("/tmp/root-screenshot.png");
    expect(recoveredContent).toContain("bump");

    await adapter.onMessage?.(
      createInboundMessage({
        text: "follow-up",
        messageId: "1712800002.000400",
      }),
    );

    expect(listConversationMessages).toHaveBeenCalledTimes(2);
    const markedRoute = getRoute(
      "slack",
      "C123",
      "slack-bot",
      "1712790000.000050",
    );
    expect(markedRoute?.bootstrapUserMessageSeenAt).toEqual(expect.any(String));
    const incrementalContent = contentText(deliveries[1]?.content);
    expect(incrementalContent).toContain("follow-up");
    expect(incrementalContent).not.toContain("Original root problem statement");
    expect(incrementalContent).not.toContain("Prior human investigation notes");
    expect(incrementalContent).not.toContain("/tmp/root-screenshot.png");

    await adapter.onMessage?.(
      createInboundMessage({
        text: "post-marker",
        messageId: "1712800003.000500",
      }),
    );

    expect(listConversationMessages).toHaveBeenCalledTimes(2);
    expect(contentText(deliveries[2]?.content)).toContain("post-marker");
    expect(resolveSlackThreadStarterMock).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(3);
  });

  test("an explicit Slack mention upgrades a listen-only route for outbound replies", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: Array<{ turnSources?: unknown[] }> = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(createInboundMessage());
    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "can you look?",
        messageId: "1712800001.000300",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(1);
    const route = getRoute("slack", "C123", "slack-bot", "1712790000.000050");
    expect(route).toEqual(expect.objectContaining({ outboundEnabled: true }));
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]?.turnSources).toEqual([
      expect.objectContaining({
        channel: "slack",
        accountId: "slack-bot",
        chatId: "C123",
        threadId: "1712790000.000050",
        messageId: "1712800001.000300",
        agentId: "agent-1",
        conversationId: "conv-slack",
      }),
    ]);
    expect(
      registry.getRouteForScope(
        "slack",
        "C123",
        "agent-1",
        "conv-slack",
        "slack-bot",
      ),
    ).not.toBeNull();
  });

  test("mention slash detach silences the thread until the app is mentioned again", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const adapter = createAdapter();
    registry.registerAdapter(adapter);

    const deliveries: Array<{ turnSources?: unknown[] }> = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "please take a look",
        messageId: "1712800001.000300",
      }),
    );
    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "/detach",
        messageId: "1712800002.000400",
      }),
    );

    let route = getRoute("slack", "C123", "slack-bot", "1712790000.000050");
    expect(route).toEqual(
      expect.objectContaining({ detached: true, outboundEnabled: false }),
    );

    await adapter.onMessage?.(
      createInboundMessage({
        text: "normal follow-up after detach",
        messageId: "1712800003.000500",
      }),
    );
    expect(deliveries).toHaveLength(1);

    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "rejoining this thread",
        messageId: "1712800004.000600",
      }),
    );

    route = getRoute("slack", "C123", "slack-bot", "1712790000.000050");
    expect(route).toEqual(
      expect.objectContaining({ detached: false, outboundEnabled: true }),
    );
    expect(deliveries).toHaveLength(2);
  });

  test("mention bang help in a DM is handled before agent delivery", async () => {
    const { ChannelRegistry } = await import("@/channels/registry");
    const registry = new ChannelRegistry();
    const replies: string[] = [];
    const adapter = {
      ...createAdapter(),
      sendDirectReply: async (_chatId: string, text: string) => {
        replies.push(text);
      },
    };
    registry.registerAdapter(adapter);

    const deliveries: unknown[] = [];
    registry.setMessageHandler((delivery) => {
      deliveries.push(delivery);
    });
    registry.setReady();

    await adapter.onMessage?.(
      createInboundMessage({
        chatId: "D123",
        chatType: "direct",
        threadId: null,
        isMention: true,
        text: "!help",
        messageId: "1712800001.000300",
      }),
    );

    expect(deliveries).toEqual([]);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain(
      "Control commands start immediately after the mention",
    );
    expect(replies[0]).toContain("@agent /model <handle-or-id>");
    expect(replies[0]).toContain("Legacy bang aliases still work");
  });

  test("unmentioned bang text stays normal routed Slack input", async () => {
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
        isMention: true,
        text: "please take a look",
        messageId: "1712800001.000300",
      }),
    );
    await adapter.onMessage?.(
      createInboundMessage({
        text: "!detach",
        messageId: "1712800002.000400",
      }),
    );

    const route = getRoute("slack", "C123", "slack-bot", "1712790000.000050");
    expect(route).toEqual(expect.objectContaining({ outboundEnabled: true }));
    expect(route?.detached).not.toBe(true);
    expect(deliveries).toHaveLength(2);
  });

  test("mention slash new replaces the Slack thread route conversation", async () => {
    createConversation
      .mockResolvedValueOnce({ id: "conv-original" })
      .mockResolvedValueOnce({ id: "conv-replacement" });

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
        isMention: true,
        text: "please take a look",
        messageId: "1712800001.000300",
      }),
    );
    await adapter.onMessage?.(
      createInboundMessage({
        isMention: true,
        text: "/new",
        messageId: "1712800002.000400",
      }),
    );

    expect(createConversation).toHaveBeenCalledTimes(2);
    expect(getRoute("slack", "C123", "slack-bot", "1712790000.000050")).toEqual(
      expect.objectContaining({
        conversationId: "conv-replacement",
        detached: false,
        outboundEnabled: true,
      }),
    );
    expect(deliveries).toHaveLength(1);
  });
});
