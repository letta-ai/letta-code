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
});
