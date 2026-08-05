import type {
  ChannelAccount,
  ChannelAdapter,
  InboundChannelMessage,
} from "@/channels/types";
import { isCustomChannelAccount } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";
import { createLinearClient } from "./client";
import {
  buildLinearConversationSummary,
  buildLinearNotificationText,
  clipLinearText,
  DIRECT_LINEAR_NOTIFICATION_TYPES,
  displayLinearPerson,
  serializeLinearIssue,
} from "./notification";
import {
  createLinearPollStateStore,
  type LinearPollState,
  type LinearPollStateStore,
  MAX_LINEAR_SEEN_NOTIFICATIONS,
} from "./state";
import type {
  LinearClient,
  LinearIssueNotification,
  LinearViewer,
} from "./types";

const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const MAX_POLL_INTERVAL_MS = 60_000;
const NOTIFICATION_PAGE_SIZE = 100;
const POLL_CHECKPOINT_OVERLAP_MS = 60_000;

type PendingLinearReply = {
  notificationId: string;
  parentId: string;
};

export interface LinearAdapterDependencies {
  client?: LinearClient;
  stateStore?: LinearPollStateStore;
  now?: () => Date;
  schedulePoll?: (
    callback: () => Promise<void>,
    intervalMs: number,
  ) => () => void;
}

function readConfigString(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readPollInterval(config: Record<string, unknown>): number {
  const value = Number(config.poll_interval_ms ?? DEFAULT_POLL_INTERVAL_MS);
  return Number.isInteger(value) &&
    value >= MIN_POLL_INTERVAL_MS &&
    value <= MAX_POLL_INTERVAL_MS
    ? value
    : DEFAULT_POLL_INTERVAL_MS;
}

function defaultSchedulePoll(
  callback: () => Promise<void>,
  intervalMs: number,
): () => void {
  const timer = setInterval(() => void callback(), intervalMs);
  return () => clearInterval(timer);
}

function appendSeenNotification(
  current: Set<string>,
  notificationId: string,
): Set<string> {
  const next = new Set(current);
  next.delete(notificationId);
  next.add(notificationId);
  while (next.size > MAX_LINEAR_SEEN_NOTIFICATIONS) {
    const oldest = next.values().next().value;
    if (!oldest) break;
    next.delete(oldest);
  }
  return next;
}

function buildPollState(
  initializedAt: string,
  seen: Set<string>,
): LinearPollState {
  return {
    version: 1,
    initializedAt,
    seenNotificationIds: [...seen],
  };
}

function getConversationSummary(msg: InboundChannelMessage): string | null {
  if (!isRecord(msg.raw)) return null;
  return typeof msg.raw.conversationSummary === "string"
    ? msg.raw.conversationSummary
    : null;
}

export function createLinearAdapter(
  account: ChannelAccount,
  dependencies: LinearAdapterDependencies = {},
): ChannelAdapter {
  if (!isCustomChannelAccount(account) || account.channel !== "linear") {
    throw new Error("Linear adapter requires a Linear plugin account.");
  }
  const config = account.config;
  const apiKey = readConfigString(config, "auth");
  const agentId = readConfigString(config, "agent_id");
  const pollIntervalMs = readPollInterval(config);
  const replyEnabled =
    typeof config.reply_enabled === "boolean" ? config.reply_enabled : true;
  const client = dependencies.client ?? createLinearClient(apiKey ?? "");
  const stateStore =
    dependencies.stateStore ?? createLinearPollStateStore(account.accountId);
  const now = dependencies.now ?? (() => new Date());
  const schedulePoll = dependencies.schedulePoll ?? defaultSchedulePoll;

  let pollState = stateStore.load();
  let seen = new Set(pollState.seenNotificationIds);
  const pendingReplyByIssue = new Map<string, PendingLinearReply>();
  const inFlightByIssue = new Map<string, string>();
  let running = false;
  let polling = false;
  let generation = 0;
  let cancelScheduledPoll: (() => void) | null = null;
  let abortController: AbortController | null = null;
  let viewer: LinearViewer | null = null;
  let logger = (_message: string): void => {};

  function persistSeen(notificationId: string): void {
    const nextSeen = appendSeenNotification(seen, notificationId);
    const nextState = buildPollState(
      pollState.initializedAt ?? now().toISOString(),
      nextSeen,
    );
    stateStore.save(nextState);
    seen = nextSeen;
    pollState = nextState;
  }

  function persistCurrentInFlight(issueId: string): void {
    const notificationId = inFlightByIssue.get(issueId);
    if (notificationId && !seen.has(notificationId)) {
      persistSeen(notificationId);
    }
  }

  function persistAfterReply(issueId: string): void {
    try {
      persistCurrentInFlight(issueId);
    } catch (error) {
      logger(
        `[Linear] Reply sent, but notification state was not saved: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  function clearCurrentInFlight(issueId: string, notificationId: string): void {
    const pending = pendingReplyByIssue.get(issueId);
    if (pending?.notificationId === notificationId) {
      pendingReplyByIssue.delete(issueId);
    }
    if (inFlightByIssue.get(issueId) === notificationId) {
      inFlightByIssue.delete(issueId);
    }
  }

  function persistBaseline(
    notifications: LinearIssueNotification[],
    initializedAt: string,
  ): void {
    let nextSeen = new Set(seen);
    for (const notification of notifications) {
      nextSeen = appendSeenNotification(nextSeen, notification.id);
    }
    const nextState = buildPollState(initializedAt, nextSeen);
    stateStore.save(nextState);
    seen = nextSeen;
    pollState = nextState;
  }

  function advancePollingCheckpoint(
    notifications: LinearIssueNotification[],
    pollStartedAt: string,
  ): void {
    const notificationsById = new Map(
      notifications.map((notification) => [notification.id, notification]),
    );
    for (const notificationId of inFlightByIssue.values()) {
      if (!seen.has(notificationId) && !notificationsById.has(notificationId)) {
        return;
      }
    }

    let oldestUnfinished: number | null = null;
    for (const notification of notifications) {
      if (seen.has(notification.id)) continue;
      const createdAt = Date.parse(notification.createdAt);
      if (!Number.isFinite(createdAt)) return;
      oldestUnfinished =
        oldestUnfinished === null
          ? createdAt
          : Math.min(oldestUnfinished, createdAt);
    }

    const current = Date.parse(pollState.initializedAt ?? "");
    const started = Date.parse(pollStartedAt);
    if (!Number.isFinite(current) || !Number.isFinite(started)) return;
    const safeUpperBound = oldestUnfinished ?? started;
    const checkpoint = new Date(
      Math.max(0, safeUpperBound - POLL_CHECKPOINT_OVERLAP_MS),
    ).toISOString();
    if (Date.parse(checkpoint) <= current) return;

    const nextState = buildPollState(checkpoint, seen);
    stateStore.save(nextState);
    pollState = nextState;
  }

  async function createComment(
    issueId: string,
    text: string,
    parentId: string | null,
  ): Promise<{ id: string }> {
    if (!running || !abortController) {
      throw new Error("Linear channel is not running.");
    }
    if (!replyEnabled) {
      throw new Error("Linear replies are disabled for this account.");
    }
    const body = text.trim();
    if (!body) throw new Error("Linear comments cannot be empty.");
    return client.createComment(
      {
        issueId,
        body,
        ...(parentId ? { parentId } : {}),
      },
      abortController.signal,
    );
  }

  async function pollOnce(expectedGeneration: number): Promise<void> {
    const controller = abortController;
    if (
      !running ||
      polling ||
      !controller ||
      controller.signal.aborted ||
      expectedGeneration !== generation
    ) {
      return;
    }
    polling = true;
    try {
      const pollStartedAt = now().toISOString();
      const notifications = await client.listIssueNotifications(
        NOTIFICATION_PAGE_SIZE,
        controller.signal,
        pollState.initializedAt
          ? { createdAfter: pollState.initializedAt }
          : undefined,
      );
      if (
        !running ||
        controller.signal.aborted ||
        expectedGeneration !== generation
      ) {
        return;
      }

      const serviceIdentity = viewer;
      if (!serviceIdentity) {
        throw new Error("Linear viewer identity is unavailable.");
      }

      if (!pollState.initializedAt) {
        persistBaseline(notifications, pollStartedAt);
        logger(
          `[Linear] Recorded ${notifications.length} existing notifications as the polling baseline.`,
        );
        return;
      }

      for (const notification of [...notifications].reverse()) {
        if (
          !running ||
          controller.signal.aborted ||
          expectedGeneration !== generation
        ) {
          return;
        }
        if (seen.has(notification.id)) continue;
        if (notification.actor?.id === serviceIdentity.id) {
          persistSeen(notification.id);
          continue;
        }
        if (inFlightByIssue.has(notification.issueId)) continue;
        if (!adapter.onMessage) {
          throw new Error(
            "Linear channel ingress is not connected to ChannelRegistry.",
          );
        }

        const replyRootId =
          notification.parentCommentId ?? notification.commentId;
        if (replyRootId) {
          pendingReplyByIssue.set(notification.issueId, {
            notificationId: notification.id,
            parentId: replyRootId,
          });
        } else {
          pendingReplyByIssue.delete(notification.issueId);
        }

        inFlightByIssue.set(notification.issueId, notification.id);
        try {
          await adapter.onMessage({
            channel: "linear",
            accountId: account.accountId,
            chatId: notification.issueId,
            chatType: "channel",
            chatLabel: `${notification.issue.identifier} ${notification.issue.title}`,
            senderId: notification.actor?.id ?? "linear-system",
            senderName: displayLinearPerson(notification.actor, "Linear"),
            text: buildLinearNotificationText(notification, serviceIdentity),
            timestamp: Date.parse(notification.createdAt) || now().getTime(),
            messageId: notification.id,
            threadId: null,
            isMention: DIRECT_LINEAR_NOTIFICATION_TYPES.has(notification.type),
            isOpenChannel: true,
            ...(notification.comment
              ? {
                  replyContext: {
                    messageId: notification.comment.id,
                    senderId: notification.actor?.id,
                    senderName: displayLinearPerson(
                      notification.actor,
                      "Linear",
                    ),
                    text: clipLinearText(notification.comment.body),
                  },
                }
              : {}),
            raw: {
              notificationId: notification.id,
              notificationType: notification.type,
              issue: serializeLinearIssue(notification.issue),
              conversationSummary: buildLinearConversationSummary(notification),
            },
          });
        } catch (error) {
          clearCurrentInFlight(notification.issueId, notification.id);
          throw error;
        }
      }
      advancePollingCheckpoint(notifications, pollStartedAt);
    } catch (error) {
      if (running && !controller.signal.aborted) {
        logger(
          `[Linear] Poll failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } finally {
      polling = false;
    }
  }

  const adapter: ChannelAdapter = {
    id: `linear:${account.accountId}`,
    channelId: "linear",
    accountId: account.accountId,
    name: account.displayName ?? "Linear",

    async start(options) {
      if (running) return;
      if (!apiKey) throw new Error("Linear channel requires config.auth.");
      if (!agentId) throw new Error("Linear channel requires config.agent_id.");
      logger = options?.logger ?? (() => {});
      generation += 1;
      const startGeneration = generation;
      abortController = new AbortController();
      try {
        viewer = await client.getViewer(abortController.signal);
        running = true;
        logger(
          `[Linear] Polling ${displayLinearPerson(viewer)} in ${viewer.organization?.name ?? "the configured workspace"} every ${pollIntervalMs}ms.`,
        );
        await pollOnce(startGeneration);
        if (running && startGeneration === generation) {
          cancelScheduledPoll = schedulePoll(
            () => pollOnce(startGeneration),
            pollIntervalMs,
          );
        }
      } catch (error) {
        abortController.abort();
        abortController = null;
        running = false;
        throw error;
      }
    },

    async stop() {
      running = false;
      generation += 1;
      abortController?.abort();
      abortController = null;
      cancelScheduledPoll?.();
      cancelScheduledPoll = null;
      pendingReplyByIssue.clear();
      inFlightByIssue.clear();
    },

    isRunning() {
      return running;
    },

    async resolveAutoRoute(msg) {
      if (!agentId || msg.channel !== "linear") return null;
      return {
        agentId,
        conversationSummary:
          getConversationSummary(msg) ??
          `${msg.chatLabel ?? "Linear issue"}\nlinear-channel:issue:${msg.chatId}`,
      };
    },

    async sendMessage(message) {
      const pending = pendingReplyByIssue.get(message.chatId);
      const parentId = message.replyToMessageId ?? pending?.parentId ?? null;
      const comment = await createComment(
        message.chatId,
        message.text,
        parentId,
      );
      persistAfterReply(message.chatId);
      pendingReplyByIssue.delete(message.chatId);
      return { messageId: comment.id };
    },

    async sendDirectReply(chatId, text, options) {
      const pending = pendingReplyByIssue.get(chatId);
      const parentId = options?.replyToMessageId ?? pending?.parentId ?? null;
      await createComment(chatId, text, parentId);
      persistAfterReply(chatId);
      pendingReplyByIssue.delete(chatId);
    },

    async handleTurnLifecycleEvent(event) {
      if (event.type !== "finished") return;
      let persistenceError: unknown;
      for (const source of event.sources) {
        if (
          source.channel !== "linear" ||
          source.accountId !== account.accountId
        ) {
          continue;
        }
        const notificationId = inFlightByIssue.get(source.chatId);
        if (!notificationId || notificationId !== source.messageId) continue;
        if (event.outcome === "completed" && !seen.has(notificationId)) {
          try {
            persistSeen(notificationId);
          } catch (error) {
            persistenceError ??= error;
          }
        }
        clearCurrentInFlight(source.chatId, notificationId);
      }
      if (persistenceError) throw persistenceError;
    },
  };

  return adapter;
}
