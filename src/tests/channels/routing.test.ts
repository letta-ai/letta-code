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
} from "../../channels/routing";

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
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const route = getRoute("telegram", "chat-1");
    expect(route).not.toBeNull();
    expect(route?.agentId).toBe("agent-a");
    expect(route?.conversationId).toBe("conv-1");
  });

  test("returns null for non-existent route", () => {
    expect(getRoute("telegram", "nonexistent")).toBeNull();
  });

  test("returns null for disabled route", () => {
    addRoute("telegram", {
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: false,
      createdAt: new Date().toISOString(),
    });

    expect(getRoute("telegram", "chat-1")).toBeNull();
  });

  test("removes a route", () => {
    addRoute("telegram", {
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(removeRoute("telegram", "chat-1")).toBe(true);
    expect(getRoute("telegram", "chat-1")).toBeNull();
  });

  test("removeRoutesForScope removes matching routes", () => {
    addRoute("telegram", {
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "chat-2",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });
    addRoute("telegram", {
      chatId: "chat-3",
      agentId: "agent-b",
      conversationId: "conv-2",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const removed = removeRoutesForScope("telegram", "agent-a", "conv-1");
    expect(removed).toBe(2);

    expect(getRoute("telegram", "chat-1")).toBeNull();
    expect(getRoute("telegram", "chat-2")).toBeNull();
    expect(getRoute("telegram", "chat-3")).not.toBeNull();
  });

  test("getRoutesForChannel returns channel-specific routes", () => {
    addRoute("telegram", {
      chatId: "chat-1",
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
      chatId: "chat-1",
      agentId: "agent-a",
      conversationId: "conv-1",
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    expect(getAllRoutes()).toHaveLength(1);
  });
});
