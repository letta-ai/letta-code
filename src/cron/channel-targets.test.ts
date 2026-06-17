import { afterEach, describe, expect, test } from "bun:test";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  setRouteInMemory,
} from "@/channels/routing";
import type { ChannelAdapter } from "@/channels/types";
import {
  extractCronChannelTargetsFromInheritedContext,
  resolveCronChannelContext,
} from "./channel-targets";
import type { CronTask } from "./cron-file";

function createAdapter(params: {
  channelId: string;
  accountId: string;
  running?: boolean;
}): ChannelAdapter {
  return {
    id: `${params.channelId}:${params.accountId}`,
    channelId: params.channelId,
    accountId: params.accountId,
    name: params.channelId,
    start: async () => {},
    stop: async () => {},
    isRunning: () => params.running ?? true,
    sendMessage: async () => ({ messageId: "msg-1" }),
    sendDirectReply: async () => {},
  };
}

function createTask(overrides: Partial<CronTask> = {}): CronTask {
  return {
    id: "cron-1",
    agent_id: "agent-1",
    conversation_id: "default",
    name: "Daily check",
    description: "Check status",
    cron: "0 9 * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "send status",
    channel_targets: [],
    status: "active",
    created_at: "2026-04-11T00:00:00.000Z",
    expires_at: null,
    last_fired_at: null,
    fire_count: 0,
    cancel_reason: null,
    jitter_offset_ms: 0,
    last_run_at: null,
    last_run_outcome: null,
    last_run_reason: null,
    last_run_error: null,
    last_missed_at: null,
    missed_count: 0,
    failed_count: 0,
    scheduled_for: null,
    fired_at: null,
    missed_at: null,
    ...overrides,
  };
}

describe("cron channel targets", () => {
  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearAllRoutes();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
  });

  test("extracts current channel turn sources for the scheduled scope", () => {
    const raw = JSON.stringify({
      channelTurnSources: [
        {
          channel: "slack",
          accountId: "acct-slack",
          chatId: "C123",
          chatType: "channel",
          threadId: "1712790000.000050",
          messageId: "1712790000.000050",
          agentId: "agent-1",
          conversationId: "default",
        },
        {
          channel: "slack",
          accountId: "acct-other",
          chatId: "C999",
          agentId: "agent-2",
          conversationId: "default",
        },
      ],
    });

    expect(
      extractCronChannelTargetsFromInheritedContext({
        raw,
        agentId: "agent-1",
        conversationId: "default",
      }),
    ).toEqual([
      {
        channel: "slack",
        account_id: "acct-slack",
        chat_id: "C123",
        chat_type: "channel",
        thread_id: "1712790000.000050",
        message_id: "1712790000.000050",
      },
    ]);
  });

  test("resolves only stored targets with live routes", () => {
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
    const registry = new ChannelRegistry();
    registry.registerAdapter(
      createAdapter({ channelId: "slack", accountId: "acct-slack" }),
    );
    registry.registerAdapter(
      createAdapter({
        channelId: "discord",
        accountId: "acct-discord",
        running: false,
      }),
    );

    setRouteInMemory("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });
    setRouteInMemory("discord", {
      accountId: "acct-discord",
      chatId: "room-123",
      chatType: "channel",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
    });

    const context = resolveCronChannelContext({
      task: createTask({
        channel_targets: [
          {
            channel: "slack",
            account_id: "acct-slack",
            chat_id: "C123",
          },
          {
            channel: "discord",
            account_id: "acct-discord",
            chat_id: "room-123",
          },
        ],
      }),
      conversationId: "default",
    });

    expect(context.channelToolScope).toEqual({
      channels: [{ channelId: "slack", accountId: "acct-slack" }],
    });
    expect(context.channelTurnSources).toEqual([
      {
        channel: "slack",
        accountId: "acct-slack",
        chatId: "C123",
        chatType: "channel",
        threadId: "1712790000.000050",
        agentId: "agent-1",
        conversationId: "default",
      },
    ]);
  });
});
