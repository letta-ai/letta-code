import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  listOutboundDeliveryTargets,
  resolveAgentDeliveryTarget,
} from "@/channels/outbound-targets";
import {
  __testOverrideLoadRoutes,
  clearAllRoutes,
  setRouteInMemory,
} from "@/channels/routing";
import {
  __testOverrideLoadTargetStore,
  __testOverrideSaveTargetStore,
  clearTargetStores,
  upsertChannelTarget,
} from "@/channels/targets";
import type { ChannelRoute } from "@/channels/types";

const AGENT_A = "agent-a";
const AGENT_B = "agent-b";

function makeRoute(overrides: Partial<ChannelRoute>): ChannelRoute {
  return {
    chatId: "chat",
    agentId: AGENT_A,
    conversationId: "conv-1",
    enabled: true,
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("outbound delivery targets", () => {
  beforeEach(() => {
    // Keep the store in-memory only: never read or write the real
    // channel config dir from tests.
    __testOverrideLoadRoutes(() => null);
    __testOverrideLoadTargetStore(() => {});
    __testOverrideSaveTargetStore(() => {});

    setRouteInMemory("telegram", makeRoute({ chatId: "111" }));
    setRouteInMemory(
      "telegram",
      makeRoute({
        chatId: "222",
        conversationId: "conv-2",
        outboundEnabled: false,
      }),
    );
    setRouteInMemory(
      "telegram",
      makeRoute({ chatId: "333", agentId: AGENT_B }),
    );
    setRouteInMemory("slack", makeRoute({ chatId: "C9", accountId: "acct_1" }));
    upsertChannelTarget("slack", {
      targetId: "C9",
      targetType: "channel",
      chatId: "C9",
      accountId: "acct_1",
      label: "#eng-alerts",
      discoveredAt: "2026-07-01T00:00:00.000Z",
      lastSeenAt: "2026-07-01T00:00:00.000Z",
    });
  });

  afterEach(() => {
    clearAllRoutes();
    clearTargetStores();
    __testOverrideLoadRoutes(null);
    __testOverrideLoadTargetStore(null);
    __testOverrideSaveTargetStore(null);
  });

  test("lists only outbound-enabled routes owned by the agent", () => {
    const targets = listOutboundDeliveryTargets({ agentId: AGENT_A });
    const chatIds = targets.map((t) => `${t.channel}:${t.chatId}`).sort();
    expect(chatIds).toEqual(["slack:C9", "telegram:111"]);
  });

  test("filters by conversation when provided", () => {
    const targets = listOutboundDeliveryTargets({
      agentId: AGENT_A,
      conversationId: "conv-2",
    });
    expect(targets).toHaveLength(0);

    const conv1 = listOutboundDeliveryTargets({
      agentId: AGENT_A,
      conversationId: "conv-1",
    });
    expect(conv1.map((t) => t.chatId).sort()).toEqual(["111", "C9"]);
  });

  test("joins discovered-target labels and falls back to chat id", () => {
    const targets = listOutboundDeliveryTargets({ agentId: AGENT_A });
    const slack = targets.find((t) => t.channel === "slack");
    const telegram = targets.find((t) => t.channel === "telegram");
    expect(slack?.label).toBe("#eng-alerts");
    expect(telegram?.label).toBe("111");
  });

  test("resolves a routed chat for the agent", () => {
    const resolved = resolveAgentDeliveryTarget({
      agentId: AGENT_A,
      channel: "slack",
      chatId: "C9",
    });
    expect(typeof resolved).not.toBe("string");
    if (typeof resolved !== "string") {
      expect(resolved.accountId).toBe("acct_1");
      expect(resolved.label).toBe("#eng-alerts");
    }
  });

  test("rejects chats not routed to the agent", () => {
    const otherAgentChat = resolveAgentDeliveryTarget({
      agentId: AGENT_A,
      channel: "telegram",
      chatId: "333",
    });
    expect(typeof otherAgentChat).toBe("string");

    const outboundDisabled = resolveAgentDeliveryTarget({
      agentId: AGENT_A,
      channel: "telegram",
      chatId: "222",
    });
    expect(typeof outboundDisabled).toBe("string");
  });

  test("requires an account id when multiple accounts cover the chat", () => {
    setRouteInMemory("slack", makeRoute({ chatId: "C9", accountId: "acct_2" }));

    const ambiguous = resolveAgentDeliveryTarget({
      agentId: AGENT_A,
      channel: "slack",
      chatId: "C9",
    });
    expect(ambiguous).toContain("Multiple accounts");

    const disambiguated = resolveAgentDeliveryTarget({
      agentId: AGENT_A,
      channel: "slack",
      chatId: "C9",
      accountId: "acct_2",
    });
    expect(typeof disambiguated).not.toBe("string");
    if (typeof disambiguated !== "string") {
      expect(disambiguated.accountId).toBe("acct_2");
    }
  });
});
