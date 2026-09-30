import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tryHandleChannelSlashCommand } from "./commands";
import { createChannelCommandRouter } from "./registry-commands";
import { createChannelRouteProvisioner } from "./registry-routes";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
  getRouteRaw,
  getRoutesForChannel,
  loadRoutes,
} from "./routing";
import type {
  ChannelAdapter,
  ChannelRoute,
  InboundChannelMessage,
} from "./types";

const msg: InboundChannelMessage = {
  channel: "telegram",
  accountId: "bot-1",
  chatId: "123",
  senderId: "456",
  senderName: "Alice",
  text: "/new",
  timestamp: 0,
  chatType: "direct",
};
const original: ChannelRoute = {
  accountId: "bot-1",
  chatId: "123",
  chatType: "direct",
  threadId: null,
  agentId: "agent-original",
  conversationId: "conv-original",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
let persisted: ChannelRoute[];
let busy: boolean;
let createdFor: string[];
let createConversation: () => Promise<string>;

function makeRouter(ready = true) {
  return createChannelCommandRouter({
    routes: {
      ...createChannelRouteProvisioner({ emitEvent: () => {} }),
      createConversationForAgent: async (agentId) => {
        createdFor.push(agentId);
        return createConversation();
      },
    },
    emitEvent: () => {},
    getRoute,
    getCancelHandler: () => null,
    getModelHandler: () => null,
    getReflectionHandler: () => null,
    getReloadHandler: () => null,
    getRuntimeBusyHandler: ready ? () => isBusy : () => null,
  });
}
function isBusy() {
  return busy;
}

beforeEach(() => {
  clearAllRoutes();
  persisted = [];
  busy = false;
  createdFor = [];
  createConversation = async () => "conv-new";
  __testOverrideLoadRoutes(() => structuredClone(persisted));
  __testOverrideSaveRoutes((channelId) => {
    persisted = structuredClone(getRoutesForChannel(channelId));
  });
});
afterEach(() => {
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

describe("Telegram /new routing", () => {
  test.each([
    { chatType: "direct" as const, threadId: null },
    { chatType: "direct" as const, threadId: "private-topic" },
    { chatType: "channel" as const, threadId: "forum-topic" },
  ])("preserves agent and route scope across reload: %j", async (scope) => {
    const route = { ...original, ...scope };
    addRoute("telegram", route);
    addRoute("telegram", { ...original, chatId: "789" });
    addRoute("telegram", { ...route, accountId: "other-bot" });
    const result = await makeRouter().handleNewConversationSlashCommand({
      ...msg,
      ...scope,
    });
    expect(result.text).toContain("conv-new");
    expect(createdFor).toEqual(["agent-original"]);
    clearAllRoutes();
    loadRoutes("telegram");
    expect(getRoute("telegram", "123", "bot-1", scope.threadId)).toMatchObject({
      ...route,
      conversationId: "conv-new",
      updatedAt: expect.any(String),
    });
    expect(getRoute("telegram", "789", "bot-1")?.conversationId).toBe(
      "conv-original",
    );
    expect(
      getRoute("telegram", "123", "other-bot", scope.threadId)?.conversationId,
    ).toBe("conv-original");
  });

  test("a private topic using the root route resets that route, not another topic", async () => {
    addRoute("telegram", original);
    addRoute("telegram", {
      ...original,
      threadId: "other-topic",
      conversationId: "conv-topic",
    });
    await makeRouter().handleNewConversationSlashCommand({
      ...msg,
      threadId: "unrouted-topic",
    });
    expect(getRoute("telegram", "123", "bot-1")?.conversationId).toBe(
      "conv-new",
    );
    expect(getRoute("telegram", "123", "bot-1", "unrouted-topic")).toBeNull();
    expect(
      getRoute("telegram", "123", "bot-1", "other-topic")?.conversationId,
    ).toBe("conv-topic");
  });

  test("requires a paired route and a ready runtime guard", async () => {
    expect(
      (await makeRouter().handleNewConversationSlashCommand(msg)).text,
    ).toContain("pairing instructions");
    addRoute("telegram", original);
    expect(
      (await makeRouter(false).handleNewConversationSlashCommand(msg)).text,
    ).toContain("not ready");
    expect(createdFor).toEqual([]);
  });

  test("rejects active, queued or approval-blocked work without cancelling it", async () => {
    addRoute("telegram", original);
    busy = true;
    expect(
      (await makeRouter().handleNewConversationSlashCommand(msg)).text,
    ).toContain("/cancel");
    expect(createdFor).toEqual([]);
    expect(persisted[0]?.conversationId).toBe("conv-original");
  });

  test("rechecks work that arrives during conversation creation", async () => {
    addRoute("telegram", original);
    createConversation = async () => {
      busy = true;
      return "conv-unused";
    };
    expect(
      (await makeRouter().handleNewConversationSlashCommand(msg)).text,
    ).toContain("queued work");
    expect(persisted[0]?.conversationId).toBe("conv-original");
  });

  test("does not overwrite a concurrent route change", async () => {
    addRoute("telegram", original);
    createConversation = async () => {
      addRoute("telegram", { ...original, conversationId: "conv-other-reset" });
      return "conv-unused";
    };
    expect(
      (await makeRouter().handleNewConversationSlashCommand(msg)).text,
    ).toContain("route changed");
    expect(persisted[0]?.conversationId).toBe("conv-other-reset");
  });

  test("preserves pause and outbound settings", async () => {
    addRoute("telegram", {
      ...original,
      enabled: false,
      outboundEnabled: false,
    });
    await makeRouter().handleNewConversationSlashCommand(msg);
    expect(getRouteRaw("telegram", "123", "bot-1")).toMatchObject({
      conversationId: "conv-new",
      enabled: false,
      outboundEnabled: false,
    });
  });

  test("creation failures leave the old route and hide backend errors", async () => {
    addRoute("telegram", original);
    createConversation = async () => {
      throw new Error("secret backend error");
    };
    const result = await makeRouter().handleNewConversationSlashCommand(msg);
    expect(result.text).toContain("current route is unchanged");
    expect(result.text).not.toContain("secret");
    expect(persisted[0]?.conversationId).toBe("conv-original");
  });

  test("persistence failures restore the in-memory route", async () => {
    addRoute("telegram", original);
    __testOverrideSaveRoutes(() => {
      throw new Error("disk full");
    });
    const result = await makeRouter().handleNewConversationSlashCommand(msg);
    expect(result.text).toContain("could not save");
    expect(getRoute("telegram", "123", "bot-1")?.conversationId).toBe(
      "conv-original",
    );
    expect(persisted[0]?.conversationId).toBe("conv-original");
  });

  test("command gate denies /new before it can create a conversation", async () => {
    addRoute("telegram", original);
    const replies: string[] = [];
    const adapter: ChannelAdapter = {
      id: "telegram:bot-1",
      channelId: "telegram",
      name: "Telegram",
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "reply" }),
      sendDirectReply: async (_chatId, text) => {
        replies.push(text);
      },
    };
    const router = makeRouter();
    await tryHandleChannelSlashCommand(adapter, msg, {
      commandGate: { enabled: true, allowedCommands: [], isAdmin: false },
      handlers: {
        newConversation: async (_command, message) =>
          router.handleNewConversationSlashCommand(message),
      },
    });
    expect(createdFor).toEqual([]);
    expect(replies[0]).toContain("limited to admins");
  });
});
