import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getAllRoutes,
  getRoute,
  getRoutesForChannel,
  removeRoute,
  removeRoutesForScope,
  subscribeChannelRoutesChanged,
} from "@/channels/routing";

describe("routing", () => {
  beforeEach(() => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
  });

  afterEach(() => {
    clearAllRoutes();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
  });

  test("adds and retrieves a route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const route = getRoute("telegram", "1001");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
    expect(route?.conversationId).toBe("conv-1");
  });

  test("normalizes numeric Telegram Chat IDs before persistence", () => {
    addRoute("telegram", {
      chatId: " -1003904563283 ",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(getRoute("telegram", "-1003904563283")?.chatId).toBe(
      "-1003904563283",
    );
  });

  test("rejects labeled Telegram Chat IDs before persistence", () => {
    expect(() =>
      addRoute("telegram", {
        chatId: "Chat ID: 7945451305",
        agentId: "agent-a",
        conversationId: "conv-1",
        enabled: true,
        createdAt: new Date().toISOString(),
      }),
    ).toThrow("Paste only the numeric Telegram Chat ID");
    expect(getAllRoutes()).toHaveLength(0);
  });

  test("notifies subscribers after persisted route changes", () => {
    const changedChannels: string[] = [];
    const unsubscribe = subscribeChannelRoutesChanged((channelId) => {
      changedChannels.push(channelId);
    });

    try {
      addRoute("telegram", {
        chatId: "1001",
        agentId: "agent-a",
        conversationId: "conv-1",
        enabled: true,
        createdAt: new Date().toISOString(),
      });
      removeRoute("telegram", "1001");
    } finally {
      unsubscribe();
    }

    expect(changedChannels).toEqual(["telegram", "telegram"]);
  });

  test("returns null for non-existent route", () => {
    expect(getRoute("telegram", "nonexistent")).toBeNull();
  });

  test("returns null for disabled route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: false,
      createdAt: new Date().toISOString(),
    });

    expect(getRoute("telegram", "1001")).toBeNull();
  });

  test("removes a route", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(removeRoute("telegram", "1001")).toBe(true);
    expect(getRoute("telegram", "1001")).toBeNull();
  });

  test("removeRoutesForScope removes matching routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "1002",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "1003",
      agentId: "agent-b",
      conversationId: "conv-2",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const removed = removeRoutesForScope("telegram", "agent-a", "conv-1");
    expect(removed).toBe(2);

    expect(getRoute("telegram", "1001")).toBeNull();
    expect(getRoute("telegram", "1002")).toBeNull();
    expect(getRoute("telegram", "1003")).not.toBeNull();
  });

  test("getRoutesForChannel returns channel-specific routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const routes = getRoutesForChannel("telegram");
    expect(routes).toHaveLength(1);

    const slackRoutes = getRoutesForChannel("slack");
    expect(slackRoutes).toHaveLength(0);
  });

  test("getAllRoutes returns all routes", () => {
    addRoute("telegram", {
      chatId: "1001",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(getAllRoutes()).toHaveLength(1);
  });
});
