import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { ChannelRegistry } from "@/channels/registry";
import { createChannelRouteProvisioner } from "@/channels/registry-routes";
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
  listChannelTargets,
} from "@/channels/targets";
import type { ChannelAdapter, InboundChannelMessage } from "@/channels/types";

const message: InboundChannelMessage = {
  channel: "linear",
  accountId: "linear-account",
  chatId: "issue-1",
  chatType: "channel",
  chatLabel: "LET-1 Test issue",
  senderId: "user-1",
  senderName: "Cameron",
  text: "Please investigate",
  timestamp: Date.now(),
  messageId: "notification-1",
  threadId: null,
};

function createAdapter(
  resolveAutoRoute?: ChannelAdapter["resolveAutoRoute"],
): ChannelAdapter {
  return {
    id: "linear:linear-account",
    channelId: "linear",
    accountId: "linear-account",
    name: "Linear",
    start: async () => {},
    stop: async () => {},
    isRunning: () => true,
    sendMessage: async () => ({ messageId: "comment-1" }),
    sendDirectReply: async () => {},
    resolveAutoRoute,
  };
}

beforeEach(() => {
  clearAllRoutes();
  clearTargetStores();
  clearChannelAccountStores();
  clearPairingStores();
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
  __testOverrideLoadTargetStore(() => {});
  __testOverrideSaveTargetStore(() => {});
});

afterEach(() => {
  clearAllRoutes();
  clearTargetStores();
  clearChannelAccountStores();
  clearPairingStores();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
  __testOverrideLoadTargetStore(null);
  __testOverrideSaveTargetStore(null);
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadPairingStore(null);
  __testOverrideSavePairingStore(null);
});

test("centrally creates and persists an adapter-requested route", async () => {
  const events: unknown[] = [];
  const createCalls: Array<{ agent_id: string; summary?: string }> = [];
  const provisioner = createChannelRouteProvisioner({
    emitEvent: (event) => events.push(event),
    createConversation: async (params) => {
      createCalls.push(params);
      return { id: "conversation-1" };
    },
  });
  const adapter = createAdapter(async () => ({
    agentId: "agent-1",
    conversationSummary: "LET-1: Test issue",
  }));

  const result = await provisioner.ensureAutoRoute(adapter, message);

  expect(result).toMatchObject({
    isFirstRouteTurn: true,
    route: {
      accountId: "linear-account",
      chatId: "issue-1",
      threadId: null,
      agentId: "agent-1",
      conversationId: "conversation-1",
      enabled: true,
      outboundEnabled: true,
    },
  });
  expect(createCalls).toEqual([
    { agent_id: "agent-1", summary: "LET-1: Test issue" },
  ]);
  expect(getRoute("linear", "issue-1", "linear-account", null)).toMatchObject({
    conversationId: "conversation-1",
  });
  expect(listChannelTargets("linear", "linear-account")).toEqual([
    expect.objectContaining({
      targetId: "issue-1",
      chatId: "issue-1",
      label: "LET-1 Test issue",
      lastMessageId: "notification-1",
    }),
  ]);
  expect(events).toEqual([
    { type: "targets_updated", channelId: "linear" },
    {
      type: "channel_conversation_created",
      channelId: "linear",
      accountId: "linear-account",
      agentId: "agent-1",
      conversationId: "conversation-1",
    },
  ]);
});

test("reuses an existing route without invoking the adapter resolver", async () => {
  let createCount = 0;
  let resolveCount = 0;
  const provisioner = createChannelRouteProvisioner({
    emitEvent: () => {},
    createConversation: async () => {
      createCount += 1;
      return { id: `conversation-${createCount}` };
    },
  });
  const firstAdapter = createAdapter(async () => ({ agentId: "agent-1" }));
  await provisioner.ensureAutoRoute(firstAdapter, message);
  const secondAdapter = createAdapter(async () => {
    resolveCount += 1;
    return { agentId: "agent-2" };
  });

  const result = await provisioner.ensureAutoRoute(secondAdapter, message);

  expect(result?.isFirstRouteTurn).toBe(false);
  expect(result?.route.conversationId).toBe("conversation-1");
  expect(createCount).toBe(1);
  expect(resolveCount).toBe(0);
});

test("single-flights concurrent provisioning for the same route", async () => {
  let releaseConversation!: () => void;
  let announceConversationStarted!: () => void;
  const conversationGate = new Promise<void>((resolve) => {
    releaseConversation = resolve;
  });
  const conversationStarted = new Promise<void>((resolve) => {
    announceConversationStarted = resolve;
  });
  let createCount = 0;
  let resolveCount = 0;
  const events: unknown[] = [];
  const provisioner = createChannelRouteProvisioner({
    emitEvent: (event) => events.push(event),
    createConversation: async () => {
      createCount += 1;
      announceConversationStarted();
      await conversationGate;
      return { id: "conversation-shared" };
    },
  });
  const adapter = createAdapter(async () => {
    resolveCount += 1;
    return { agentId: "agent-1" };
  });

  const first = provisioner.ensureAutoRoute(adapter, message);
  const second = provisioner.ensureAutoRoute(adapter, {
    ...message,
    messageId: "notification-2",
  });
  await conversationStarted;
  expect(createCount).toBe(1);
  releaseConversation();

  const [firstResult, secondResult] = await Promise.all([first, second]);

  expect(firstResult?.route.conversationId).toBe("conversation-shared");
  expect(secondResult?.route.conversationId).toBe("conversation-shared");
  expect(firstResult?.isFirstRouteTurn).toBe(true);
  expect(secondResult?.isFirstRouteTurn).toBe(false);
  expect(createCount).toBe(1);
  expect(resolveCount).toBe(1);
  expect(
    events.filter(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "channel_conversation_created",
    ),
  ).toHaveLength(1);
});

test("falls through when the adapter does not request auto-routing", async () => {
  const provisioner = createChannelRouteProvisioner({
    emitEvent: () => {},
    createConversation: async () => ({ id: "unexpected" }),
  });

  expect(
    await provisioner.ensureAutoRoute(createAdapter(), message),
  ).toBeNull();
  expect(
    await provisioner.ensureAutoRoute(
      createAdapter(async () => null),
      message,
    ),
  ).toBeNull();
});

test("does not auto-route a sender who still requires pairing", async () => {
  __testOverrideLoadChannelAccounts((channelId) =>
    channelId === "linear"
      ? [
          {
            channel: "linear",
            accountId: "linear-account",
            enabled: true,
            dmPolicy: "pairing",
            allowedUsers: [],
            config: { agent_id: "agent-1", auth: "secret" },
            createdAt: "2026-08-03T00:00:00.000Z",
            updatedAt: "2026-08-03T00:00:00.000Z",
          },
        ]
      : [],
  );
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadPairingStore(() => null);
  __testOverrideSavePairingStore(() => {});
  let resolveCount = 0;
  const directReplies: string[] = [];
  const adapter = createAdapter(async () => {
    resolveCount += 1;
    return { agentId: "agent-1" };
  });
  adapter.sendDirectReply = async (_chatId, text) => {
    directReplies.push(text);
  };
  const registry = new ChannelRegistry();
  registry.registerAdapter(adapter);

  try {
    await adapter.onMessage?.({
      ...message,
      chatType: "direct",
      isOpenChannel: false,
    });

    expect(resolveCount).toBe(0);
    expect(directReplies).toHaveLength(1);
    expect(directReplies[0]).toContain("Pairing code:");
  } finally {
    await registry.stopAll();
  }
});

test("rejects an empty adapter-selected agent ID", async () => {
  const provisioner = createChannelRouteProvisioner({
    emitEvent: () => {},
    createConversation: async () => ({ id: "unexpected" }),
  });

  await expect(
    provisioner.ensureAutoRoute(
      createAdapter(async () => ({ agentId: "  " })),
      message,
    ),
  ).rejects.toThrow("returned an empty agentId");
});
