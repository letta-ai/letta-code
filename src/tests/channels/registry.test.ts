import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadPairingStore,
  __testOverrideSavePairingStore,
  clearPairingStores,
  createPairingCode,
  getPendingPairings,
  isUserApproved,
} from "../../channels/pairing";
import {
  buildSlackConversationSummary,
  ChannelRegistry,
  completePairing,
  getChannelRegistry,
} from "../../channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "../../channels/routing";

describe("ChannelRegistry", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
  });

  test("pause() stops delivery but keeps singleton alive", () => {
    const registry = new ChannelRegistry();
    registry.setMessageHandler(() => {});
    registry.setReady();

    expect(registry.isReady()).toBe(true);
    expect(getChannelRegistry()).toBe(registry);

    registry.pause();
    expect(registry.isReady()).toBe(false);
    // Singleton survives pause (unlike stopAll)
    expect(getChannelRegistry()).toBe(registry);

    // Re-register and setReady (simulates WS reconnect)
    registry.setMessageHandler(() => {});
    registry.setReady();
    expect(registry.isReady()).toBe(true);
  });

  test("stopAll() destroys the singleton", async () => {
    const registry = new ChannelRegistry();
    expect(getChannelRegistry()).toBe(registry);

    await registry.stopAll();
    expect(getChannelRegistry()).toBeNull();
  });
});

describe("buildSlackConversationSummary", () => {
  test("labels direct messages with the sender name", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "D123",
        chatType: "direct",
        senderId: "U123",
        senderName: "Charles",
        text: "hey there",
      }),
    ).toBe("[Slack] DM with Charles");
  });

  test("labels channel threads with a clipped text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "  what messages do you see in this thread right now?  ",
      }),
    ).toBe(
      "[Slack] Thread: what messages do you see in this thread right now?",
    );
  });

  test("includes the channel label when available", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatLabel: "#random",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "Need help with the deploy preview environment after lunch",
      }),
    ).toBe(
      "[Slack] Thread in #random: Need help with the deploy preview environment after lunch",
    );
  });

  test("falls back when a thread has no text preview", () => {
    expect(
      buildSlackConversationSummary({
        chatId: "C123",
        chatType: "channel",
        senderId: "U123",
        senderName: "Charles",
        text: "   ",
      }),
    ).toBe("[Slack] Thread C123");
  });
});

describe("completePairing", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    __testOverrideLoadPairingStore(() => null);
    __testOverrideSavePairingStore(() => {});
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    clearPairingStores();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    __testOverrideLoadPairingStore(null);
    __testOverrideSavePairingStore(null);
  });

  test("successful pairing creates route", () => {
    new ChannelRegistry();

    const code = createPairingCode("telegram", "user-1", "chat-1", "john");
    const result = completePairing("telegram", code, "agent-a", "conv-1");

    expect(result.success).toBe(true);
    expect(result.chatId).toBe("chat-1");

    const route = getRoute("telegram", "chat-1");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
    expect(route?.conversationId).toBe("conv-1");
  });

  test("invalid code returns error", () => {
    new ChannelRegistry();

    const result = completePairing("telegram", "BADCODE", "agent-a", "conv-1");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Invalid or expired");
  });

  test("rolls back both in-memory route and pairing when disk write fails", () => {
    new ChannelRegistry();

    const code = createPairingCode("telegram", "user-1", "chat-99", "john");

    // Make saveRoutes throw to simulate disk write failure.
    // addRoute() calls routesByKey.set() (succeeds) then saveRoutes() (throws).
    // The completePairing catch path must:
    //   1. Remove the in-memory route via removeRouteInMemory (no disk write)
    //   2. Restore the pending pairing code via rollbackPairingApproval
    __testOverrideSaveRoutes(() => {
      throw new Error("EACCES: permission denied");
    });

    const result = completePairing("telegram", code, "agent-a", "conv-1");

    // Should report failure with rollback
    expect(result.success).toBe(false);
    expect(result.error).toContain("rolled back");
    expect(result.error).toContain("EACCES");

    // In-memory route must NOT exist
    expect(getRoute("telegram", "chat-99")).toBeNull();

    // Pairing must be rolled back: user not approved, pending code restored
    expect(isUserApproved("telegram", "user-1")).toBe(false);
    expect(getPendingPairings("telegram")).toHaveLength(1);
    expect(getPendingPairings("telegram")[0]?.code).toBe(code);
  });

  test("restores pre-existing route when rebind fails", () => {
    new ChannelRegistry();

    // Set up an existing route for chat-50
    addRoute("telegram", {
      chatId: "chat-50",
      agentId: "agent-old",
      conversationId: "conv-old",
      enabled: true,
      createdAt: "2026-01-01T00:00:00Z",
    });

    // Verify it exists
    const before = getRoute("telegram", "chat-50");
    expect(before).not.toBeNull();
    expect(before?.agentId).toBe("agent-old");

    // Create a pairing for the same chat
    const code = createPairingCode("telegram", "user-2", "chat-50", "jane");

    // Make saveRoutes throw on the rebind attempt
    __testOverrideSaveRoutes(() => {
      throw new Error("ENOSPC: no space left");
    });

    const result = completePairing("telegram", code, "agent-new", "conv-new");
    expect(result.success).toBe(false);

    // The OLD route must still be in memory (restored from snapshot)
    const after = getRoute("telegram", "chat-50");
    expect(after).not.toBeNull();
    expect(after?.agentId).toBe("agent-old");
    expect(after?.conversationId).toBe("conv-old");
  });
});
