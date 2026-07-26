import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import { createChannelConversationHandler } from "./conversation";

afterEach(() => {
  __testSetBackend(null);
  clearAllRoutes();
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
});

describe("channel conversation command handler", () => {
  test("/conv shows the conversation menu", async () => {
    const handler = createChannelConversationHandler();
    const result = await handler({
      channelId: "slack",
      route: {
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "conv-1",
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      },
    });

    expect(result.text).toContain("Slack conversation");
    expect(result.text).toContain("Current: conv-1");
    expect(result.text).toContain("@agent /conv new [title]");
    expect(result.text).toContain("@agent /conv fork [title]");
  });

  test("/conv new creates a conversation and updates the channel route", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "channel-conv-new-"));
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const source = await backend.createConversation({
        agent_id: agent.id,
        summary: "Source conversation",
      } as never);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: agent.id,
        conversationId: source.id,
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: "new Fresh start",
      });

      const conversations = (await backend.listConversations({
        agent_id: agent.id,
      } as never)) as Conversation[];
      const created = conversations.find(
        (conversation) => conversation.summary === "Fresh start",
      );
      expect(created).toBeDefined();
      if (!created) {
        throw new Error("Expected created conversation to be listed");
      }
      expect(result.text).toBe(
        `Telegram started a new conversation ${created.id} for this chat.`,
      );
      expect(getRoute("telegram", "123", "acct-telegram")?.conversationId).toBe(
        created.id,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("/conv switch validates ownership and updates the channel route", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "channel-conv-switch-"));
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const source = await backend.createConversation({
        agent_id: agent.id,
        summary: "Source conversation",
      } as never);
      const target = await backend.createConversation({
        agent_id: agent.id,
        summary: "Target conversation",
      } as never);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: agent.id,
        conversationId: source.id,
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: `switch ${target.id}`,
      });

      expect(result.text).toBe(
        `Telegram switched this chat to conversation ${target.id}.`,
      );
      expect(getRoute("telegram", "123", "acct-telegram")?.conversationId).toBe(
        target.id,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("/conv switch rejects conversations owned by a different agent", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "channel-conv-switch-wrong-agent-"),
    );
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const routeAgent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const otherAgent = await backend.createAgent({
        name: "Other Agent",
      } as AgentCreateBody);
      const source = await backend.createConversation({
        agent_id: routeAgent.id,
        summary: "Source conversation",
      } as never);
      const otherConversation = await backend.createConversation({
        agent_id: otherAgent.id,
        summary: "Other conversation",
      } as never);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: routeAgent.id,
        conversationId: source.id,
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: `switch ${otherConversation.id}`,
      });

      expect(result.text).toBe(
        `Telegram cannot switch to ${otherConversation.id} because it belongs to a different agent.`,
      );
      expect(getRoute("telegram", "123", "acct-telegram")?.conversationId).toBe(
        source.id,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("/conv fork forks the current conversation and updates the channel route", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "channel-conv-fork-"));
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const source = await backend.createConversation({
        agent_id: agent.id,
        summary: "Source conversation",
      } as never);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: agent.id,
        conversationId: source.id,
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: "fork Follow-up branch",
      });

      const conversationsPage = await backend.listConversations({
        agent_id: agent.id,
      } as never);
      const conversations = conversationsPage as Conversation[];
      const forked = conversations.find(
        (conversation) => conversation.summary === "Follow-up branch",
      );
      expect(forked).toBeDefined();
      if (!forked) {
        throw new Error("Expected forked conversation to be listed");
      }
      expect(result.text).toContain(
        `Telegram forked this chat from ${source.id} to ${forked.id}.`,
      );
      expect(getRoute("telegram", "123", "acct-telegram")?.conversationId).toBe(
        forked.id,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("/conv fork forks the default conversation for the routed agent", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "channel-conv-fork-default-"),
    );
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: agent.id,
        conversationId: "default",
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: "fork Default fork",
      });

      const forkedConversationId = getRoute(
        "telegram",
        "123",
        "acct-telegram",
      )?.conversationId;
      expect(forkedConversationId).toBeString();
      expect(forkedConversationId).not.toBe("default");
      const forked = await backend.retrieveConversation(
        forkedConversationId ?? "",
      );
      expect((forked as { agent_id?: string }).agent_id).toBe(agent.id);
      expect(forked.summary).toBe("Default fork");
      expect(result.text).toContain(
        `Telegram forked this chat from default to ${forkedConversationId}.`,
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("/conv list passes the page cursor without trusting page object cursors", async () => {
    const calls: unknown[] = [];
    __testSetBackend({
      listConversations: async (body: unknown) => {
        calls.push(body);
        return {
          getPaginatedItems: () => [
            { id: "conv-2", summary: "Second" },
            { id: "conv-3", summary: "Third" },
          ],
          hasNextPage: () => true,
        };
      },
    } as never);

    const handler = createChannelConversationHandler();
    const result = await handler({
      channelId: "telegram",
      route: {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      },
      args: "list conv-1",
    });

    expect(calls).toEqual([
      {
        agent_id: "agent-1",
        limit: 9,
        after: "conv-1",
        order: "desc",
        order_by: "last_message_at",
      },
    ]);
    expect(result.text).toContain("recent conversations for routed agent");
    expect(result.text).toContain("Showing up to 8 conversations.");
    expect(result.text).not.toContain("show more");
  });

  test("/conv list fetches one extra array item but shows a capped page", async () => {
    __testSetBackend({
      listConversations: async () =>
        Array.from({ length: 9 }, (_, index) => ({
          id: `conv-${index + 1}`,
          summary: `Conversation ${index + 1}`,
        })),
    } as never);

    const handler = createChannelConversationHandler();
    const result = await handler({
      channelId: "telegram",
      route: {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct",
        threadId: null,
        agentId: "agent-1",
        conversationId: "conv-1",
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      },
      args: "list",
    });

    expect(result.text).toContain("- conv-8 - Conversation 8");
    expect(result.text).not.toContain("conv-9");
    expect(result.text).toContain("Use /conv list conv-8 to show more.");
  });

  test("/conv failures do not leak backend error details to the channel", async () => {
    const originalConsoleError = console.error;
    const originalLettaDebug = process.env.LETTA_DEBUG;
    const logged: unknown[][] = [];
    try {
      console.error = (...args: unknown[]) => {
        logged.push(args);
      };
      process.env.LETTA_DEBUG = "1";
      __testSetBackend({
        listConversations: async () => {
          throw new Error("database password secret-token");
        },
      } as never);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route: {
          accountId: "acct-telegram",
          chatId: "123",
          chatType: "direct",
          threadId: null,
          agentId: "agent-1",
          conversationId: "conv-1",
          enabled: true,
          createdAt: "2026-05-19T00:00:00.000Z",
        },
        args: "list",
      });

      expect(result.text).toBe(
        "Telegram could not list conversations right now. Try again in a moment.",
      );
      expect(result.text).not.toContain("secret-token");
      expect(JSON.stringify(logged)).toContain("secret-token");
    } finally {
      console.error = originalConsoleError;
      if (originalLettaDebug === undefined) {
        delete process.env.LETTA_DEBUG;
      } else {
        process.env.LETTA_DEBUG = originalLettaDebug;
      }
    }
  });

  test("/conv fork updates the route when title update fails after fork", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "channel-conv-fork-title-failure-"),
    );
    try {
      __testOverrideLoadRoutes(() => null);
      __testOverrideSaveRoutes(() => {});

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const updateConversation = backend.updateConversation.bind(backend);
      backend.updateConversation = (async (conversationId, body) => {
        const summary = (body as { summary?: unknown }).summary;
        if (typeof summary === "string" && summary === "Broken rename") {
          throw new Error("rename failed");
        }
        return updateConversation(conversationId, body);
      }) as typeof backend.updateConversation;
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Channel Conversation Agent",
      } as AgentCreateBody);
      const source = await backend.createConversation({
        agent_id: agent.id,
        summary: "Source conversation",
      } as never);
      const route = {
        accountId: "acct-telegram",
        chatId: "123",
        chatType: "direct" as const,
        threadId: null,
        agentId: agent.id,
        conversationId: source.id,
        enabled: true,
        createdAt: "2026-05-19T00:00:00.000Z",
      };
      addRoute("telegram", route);

      const handler = createChannelConversationHandler();
      const result = await handler({
        channelId: "telegram",
        route,
        args: "fork Broken rename",
      });

      const updatedConversationId = getRoute(
        "telegram",
        "123",
        "acct-telegram",
      )?.conversationId;
      expect(updatedConversationId).toBeString();
      expect(updatedConversationId).not.toBe(source.id);
      expect(result.text).toContain(
        `Telegram forked this chat from ${source.id} to ${updatedConversationId}`,
      );
      expect(result.text).toContain("could not set the title");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
