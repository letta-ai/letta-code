import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  getChannelAccount,
  upsertChannelAccount,
} from "@/channels/accounts";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  addRoute,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import {
  updateChannelRoutesLive,
  validateChannelRouteTargets,
} from "@/channels/service-route-bindings";
import type {
  ChannelRoute,
  SlackChannelAccount,
  TelegramChannelAccount,
} from "@/channels/types";

function resetState(): void {
  clearChannelAccountStores();
  clearAllRoutes();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
}

beforeEach(() => {
  resetState();
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
});

afterEach(() => {
  resetState();
});

function seedSlackAccount(accountId: string): void {
  upsertChannelAccount("slack", {
    channel: "slack",
    accountId,
    displayName: `Slack ${accountId}`,
    enabled: true,
    mode: "socket",
    botToken: `xoxb-${accountId}`,
    appToken: `xapp-${accountId}`,
    agentId: null,
    dmPolicy: "open",
    allowedUsers: [],
    defaultPermissionMode: "standard",
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  } satisfies SlackChannelAccount);
}

function seedTelegramAccount(accountId: string): void {
  upsertChannelAccount("telegram", {
    channel: "telegram",
    accountId,
    displayName: `Telegram ${accountId}`,
    enabled: true,
    token: `telegram-${accountId}`,
    binding: {
      agentId: "agent-old",
      conversationId: "conv-old",
    },
    dmPolicy: "open",
    allowedUsers: [],
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
  } satisfies TelegramChannelAccount);
}

function addSlackRoute(
  route: Partial<ChannelRoute> & { chatId: string },
): void {
  const { chatId, ...overrides } = route;
  addRoute("slack", {
    accountId: "docsbot",
    chatId,
    chatType: "channel",
    threadId: null,
    agentId: "agent-old",
    conversationId: "conv-old",
    enabled: true,
    outboundEnabled: true,
    createdAt: "2026-04-11T00:00:00.000Z",
    updatedAt: "2026-04-11T00:00:00.000Z",
    ...overrides,
  });
}

describe("updateChannelRoutesLive", () => {
  test("rolls back an existing route when a later route save fails", () => {
    seedSlackAccount("docsbot");
    seedSlackAccount("backupbot");
    addSlackRoute({
      chatId: "C-existing",
      chatType: "channel",
      threadId: "1712790000.000100",
      outboundEnabled: false,
      detached: true,
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T01:00:00.000Z",
    });

    let saveCalls = 0;
    __testOverrideSaveRoutes(() => {
      saveCalls += 1;
      if (saveCalls === 2) {
        throw new Error("ENOSPC: no space left");
      }
    });

    expect(() =>
      updateChannelRoutesLive(
        [
          {
            channelId: "slack",
            accountId: "docsbot",
            chatId: "C-existing",
          },
          {
            channelId: "slack",
            accountId: "backupbot",
            chatId: "C-new-fails",
          },
        ],
        "agent-new",
        "conv-new",
      ),
    ).toThrow(/rolled back/i);

    expect(
      getRoute("slack", "C-existing", "docsbot", "1712790000.000100"),
    ).toEqual(
      expect.objectContaining({
        accountId: "docsbot",
        chatId: "C-existing",
        chatType: "channel",
        threadId: "1712790000.000100",
        agentId: "agent-old",
        conversationId: "conv-old",
        outboundEnabled: false,
        detached: true,
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T01:00:00.000Z",
      }),
    );
    expect(getRoute("slack", "C-new-fails", "backupbot")).toBeNull();
  });

  test("removes a newly-created earlier route when a later route save fails", () => {
    seedSlackAccount("docsbot");
    seedSlackAccount("backupbot");

    let saveCalls = 0;
    __testOverrideSaveRoutes(() => {
      saveCalls += 1;
      if (saveCalls === 2) {
        throw new Error("EIO: disk write failed");
      }
    });

    expect(() =>
      updateChannelRoutesLive(
        [
          {
            channelId: "slack",
            accountId: "docsbot",
            chatId: "C-created",
          },
          {
            channelId: "slack",
            accountId: "backupbot",
            chatId: "C-fails",
          },
        ],
        "agent-new",
        "conv-new",
      ),
    ).toThrow(/rolled back/i);

    expect(getRoute("slack", "C-created", "docsbot")).toBeNull();
    expect(getRoute("slack", "C-fails", "backupbot")).toBeNull();
  });

  test("dedupes duplicate targets before mutating", () => {
    seedSlackAccount("docsbot");
    let saveCalls = 0;
    __testOverrideSaveRoutes(() => {
      saveCalls += 1;
    });

    const snapshots = updateChannelRoutesLive(
      [
        {
          channelId: "slack",
          accountId: "docsbot",
          chatId: "C-dedupe",
        },
        {
          channelId: "slack",
          accountId: "docsbot",
          chatId: "C-dedupe",
        },
      ],
      "agent-new",
      "conv-new",
    );

    expect(snapshots).toHaveLength(1);
    expect(saveCalls).toBe(1);
    expect(getRoute("slack", "C-dedupe", "docsbot")).toMatchObject({
      agentId: "agent-new",
      conversationId: "conv-new",
    });
  });

  test("rolls back Telegram account binding with the route batch", () => {
    seedTelegramAccount("telegram-bot");
    seedSlackAccount("docsbot");

    let saveCalls = 0;
    __testOverrideSaveRoutes(() => {
      saveCalls += 1;
      if (saveCalls === 2) {
        throw new Error("EIO: disk write failed");
      }
    });

    expect(() =>
      updateChannelRoutesLive(
        [
          {
            channelId: "telegram",
            accountId: "telegram-bot",
            chatId: "8450770457",
          },
          {
            channelId: "slack",
            accountId: "docsbot",
            chatId: "C-fails",
          },
        ],
        "agent-new",
        "conv-new",
      ),
    ).toThrow(/rolled back/i);

    expect(getRoute("telegram", "8450770457", "telegram-bot")).toBeNull();
    expect(getRoute("slack", "C-fails", "docsbot")).toBeNull();
    expect(getChannelAccount("telegram", "telegram-bot")).toMatchObject({
      binding: {
        agentId: "agent-old",
        conversationId: "conv-old",
      },
    });
  });

  test("binds the root route without moving sibling thread routes", () => {
    seedSlackAccount("docsbot");
    addSlackRoute({ chatId: "C-with-threads", threadId: null });
    addSlackRoute({
      chatId: "C-with-threads",
      threadId: "1712790000.000100",
      conversationId: "conv-thread",
    });

    updateChannelRoutesLive(
      [
        {
          channelId: "slack",
          accountId: "docsbot",
          chatId: "C-with-threads",
          threadId: null,
        },
      ],
      "agent-new",
      "conv-new",
    );

    expect(getRoute("slack", "C-with-threads", "docsbot", null)).toMatchObject({
      agentId: "agent-new",
      conversationId: "conv-new",
    });
    expect(
      getRoute("slack", "C-with-threads", "docsbot", "1712790000.000100"),
    ).toMatchObject({
      agentId: "agent-old",
      conversationId: "conv-thread",
    });
  });

  test("rejects a stale explicit account before scheduling work", () => {
    addSlackRoute({ chatId: "C-stale", accountId: "deleted-account" });

    expect(() =>
      validateChannelRouteTargets([
        {
          channelId: "slack",
          accountId: "deleted-account",
          chatId: "C-stale",
          threadId: null,
        },
      ]),
    ).toThrow(/was not found/i);
  });

  test("rejects routes that are disabled for outbound messaging", () => {
    seedSlackAccount("docsbot");
    addSlackRoute({
      chatId: "C-listen-only",
      threadId: null,
      outboundEnabled: false,
    });

    expect(() =>
      validateChannelRouteTargets([
        {
          channelId: "slack",
          accountId: "docsbot",
          chatId: "C-listen-only",
          threadId: null,
        },
      ]),
    ).toThrow(/not enabled for outbound/i);
  });
});
