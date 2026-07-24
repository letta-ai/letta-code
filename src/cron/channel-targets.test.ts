import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  getRoute,
} from "@/channels/routing";
import type { SlackChannelAccount } from "@/channels/types";
import { type CronPromptQueueItem, QueueRuntime } from "@/queue/queue-runtime";
import {
  enqueueCronPromptWithChannelTargets,
  validateCronChannelTargets,
} from "./channel-targets";
import { addTask, type CronTask } from "./cron-file";

const TEST_DIR = path.join(import.meta.dir, ".test-cron-channel-targets");
const originalLettaHome = process.env.LETTA_HOME;

function resetState(): void {
  clearChannelAccountStores();
  clearAllRoutes();
  __testOverrideLoadChannelAccounts(null);
  __testOverrideSaveChannelAccounts(null);
  __testOverrideLoadRoutes(null);
  __testOverrideSaveRoutes(null);
}

beforeEach(() => {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.LETTA_HOME = TEST_DIR;
  resetState();
  __testOverrideLoadChannelAccounts(() => []);
  __testOverrideSaveChannelAccounts(() => {});
  __testOverrideLoadRoutes(() => null);
  __testOverrideSaveRoutes(() => {});
});

afterEach(() => {
  resetState();
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  if (originalLettaHome) process.env.LETTA_HOME = originalLettaHome;
  else delete process.env.LETTA_HOME;
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

function makeTask(targets: NonNullable<CronTask["channel_targets"]>): CronTask {
  return addTask({
    agent_id: "agent-1",
    conversation_id: "new",
    name: "Daily check-in",
    description: "",
    cron: "0 9 * * *",
    timezone: "UTC",
    recurring: true,
    prompt: "Check in",
    channel_targets: targets,
  }).task;
}

function enqueueForConversation(
  queueRuntime: QueueRuntime,
  task: CronTask,
  conversationId: string,
) {
  return enqueueCronPromptWithChannelTargets({
    queueRuntime,
    task,
    conversationId,
    getAdapter: () => ({ isRunning: () => true }),
    queueItem: {
      kind: "cron_prompt",
      source: "cron",
      text: "scheduled prompt",
      cronTaskId: task.id,
      agentId: task.agent_id,
      conversationId,
    },
  });
}

describe("cron channel targets", () => {
  test("validates before conversation creation without moving routes", () => {
    seedSlackAccount("workspace-1");
    const task = makeTask([
      {
        channel_id: "slack",
        account_id: "workspace-1",
        chat_id: "C123",
      },
    ]);

    validateCronChannelTargets(task, () => ({ isRunning: () => true }));

    expect(getRoute("slack", "C123", "workspace-1", null)).toBeNull();
  });

  test("resolves an omitted account id before checking runtime readiness", () => {
    seedSlackAccount("workspace-1");
    const task = makeTask([
      {
        channel_id: "slack",
        chat_id: "C123",
      },
    ]);
    const checkedAccountIds: Array<string | undefined> = [];

    validateCronChannelTargets(task, (_channelId, accountId) => {
      checkedAccountIds.push(accountId);
      return { isRunning: () => true };
    });

    expect(checkedAccountIds).toEqual(["workspace-1"]);
  });

  test("binds every target before the queued prompt can be consumed", () => {
    seedSlackAccount("workspace-1");
    seedSlackAccount("workspace-2");
    const task = makeTask([
      {
        channel_id: "slack",
        account_id: "workspace-1",
        chat_id: "C123",
      },
      {
        channel_id: "slack",
        account_id: "workspace-2",
        chat_id: "C456",
      },
    ]);
    const queueRuntime = new QueueRuntime();

    const queuedItem = enqueueForConversation(
      queueRuntime,
      task,
      "conv-created",
    );

    expect(queuedItem).not.toBeNull();
    expect(getRoute("slack", "C123", "workspace-1", null)).toMatchObject({
      agentId: "agent-1",
      conversationId: "conv-created",
    });
    expect(getRoute("slack", "C456", "workspace-2", null)).toMatchObject({
      agentId: "agent-1",
      conversationId: "conv-created",
    });
    expect(queueRuntime.tryDequeue(null)?.items).toEqual([
      expect.objectContaining({
        id: queuedItem?.id,
        conversationId: "conv-created",
      }),
    ]);
  });

  test("removes the queued prompt and rolls routes back when binding fails", () => {
    seedSlackAccount("workspace-1");
    seedSlackAccount("workspace-2");
    const task = makeTask([
      {
        channel_id: "slack",
        account_id: "workspace-1",
        chat_id: "C123",
      },
      {
        channel_id: "slack",
        account_id: "workspace-2",
        chat_id: "C456",
      },
    ]);
    const queueRuntime = new QueueRuntime();
    let saveCalls = 0;
    __testOverrideSaveRoutes(() => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("EIO: disk write failed");
    });

    expect(() =>
      enqueueForConversation(queueRuntime, task, "conv-created"),
    ).toThrow(/rolled back/i);

    expect(queueRuntime.length).toBe(0);
    expect(getRoute("slack", "C123", "workspace-1", null)).toBeNull();
    expect(getRoute("slack", "C456", "workspace-2", null)).toBeNull();
  });

  test("restores routes and preserves the existing queue when the queue is full", () => {
    seedSlackAccount("workspace-1");
    const task = makeTask([
      {
        channel_id: "slack",
        account_id: "workspace-1",
        chat_id: "C123",
      },
    ]);
    const queueRuntime = new QueueRuntime({ maxItems: 1, hardMaxItems: 1 });
    const existingItem = queueRuntime.enqueue({
      kind: "cron_prompt",
      source: "cron",
      text: "already queued",
      cronTaskId: "existing-task",
      agentId: "agent-1",
      conversationId: "conv-existing",
    } as Omit<CronPromptQueueItem, "id" | "enqueuedAt">);
    if (!existingItem) throw new Error("expected initial queued item");

    expect(
      enqueueForConversation(queueRuntime, task, "conv-created"),
    ).toBeNull();

    expect(queueRuntime.items).toHaveLength(1);
    expect(queueRuntime.items[0]?.id).toBe(existingItem.id);
    expect(getRoute("slack", "C123", "workspace-1", null)).toBeNull();
  });

  test("does not bind or enqueue when a selected channel runtime is stopped", () => {
    seedSlackAccount("workspace-1");
    const task = makeTask([
      {
        channel_id: "slack",
        account_id: "workspace-1",
        chat_id: "C123",
      },
    ]);
    const queueRuntime = new QueueRuntime();

    expect(() =>
      validateCronChannelTargets(task, () => ({ isRunning: () => false })),
    ).toThrow(/not running/i);
    expect(() =>
      enqueueCronPromptWithChannelTargets({
        queueRuntime,
        task,
        conversationId: "conv-created",
        getAdapter: () => ({ isRunning: () => false }),
        queueItem: {
          kind: "cron_prompt",
          source: "cron",
          text: "scheduled prompt",
          cronTaskId: task.id,
          agentId: task.agent_id,
          conversationId: "conv-created",
        },
      }),
    ).toThrow(/not running/i);

    expect(queueRuntime.length).toBe(0);
    expect(getRoute("slack", "C123", "workspace-1", null)).toBeNull();
  });
});
