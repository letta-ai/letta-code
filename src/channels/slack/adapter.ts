import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type SlackApp from "@slack/bolt";
import type {
  ChannelAdapter,
  ChannelApprovalEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnSource,
  InboundChannelMessage,
  OutboundChannelMessage,
  SlackChannelAccount,
} from "../types";
import {
  resolveSlackChannelHistory,
  resolveSlackInboundAttachments,
  resolveSlackThreadHistory,
  resolveSlackThreadStarter,
} from "./media";
import { loadSlackBoltModule, loadSlackWebApiModule } from "./runtime";

type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackBoltModule = typeof import("@slack/bolt") & {
  default?: unknown;
};
type SlackWriteClient = {
  chat: {
    postMessage: (args: {
      channel: string;
      text: string;
      thread_ts?: string;
      blocks?: unknown[];
    }) => Promise<{ ts?: string }>;
    update: (args: {
      channel: string;
      ts: string;
      text: string;
      blocks?: unknown[];
    }) => Promise<{ ts?: string }>;
    postEphemeral: (args: {
      channel: string;
      user: string;
      text: string;
      thread_ts?: string;
    }) => Promise<unknown>;
  };
  reactions: {
    add: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
    remove: (args: {
      channel: string;
      timestamp: string;
      name: string;
    }) => Promise<unknown>;
  };
  files: {
    getUploadURLExternal: (args: {
      filename: string;
      length: number;
    }) => Promise<{
      ok?: boolean;
      upload_url?: string;
      file_id?: string;
      error?: string;
    }>;
    completeUploadExternal: (args: {
      files: Array<{ id: string; title: string }>;
      channel_id: string;
      initial_comment?: string;
      thread_ts?: string;
    }) => Promise<{ ok?: boolean; error?: string }>;
  };
};
type SlackWriteClientConstructor = new (
  token: string,
  options?: Record<string, unknown>,
) => SlackWriteClient;
type SlackWebApiModule = {
  WebClient?: unknown;
  default?: unknown;
};
type SlackReactionEvent = {
  item?: {
    type?: string;
    channel?: string;
    ts?: string;
  };
  user?: string;
  item_user?: string;
  reaction?: string;
  event_ts?: string;
};
type SlackBlockActionPayload = {
  requestId?: string;
  decision?: "allow" | "deny";
};
type SlackApprovalPromptState = {
  chatId: string;
  threadId: string | null;
  messageTs: string;
  allowedSenderIds: Set<string>;
};

type Constructor = abstract new (...args: never[]) => unknown;

function isConstructorFunction<T extends Constructor>(
  value: unknown,
): value is T {
  return typeof value === "function";
}

function resolveSlackAppModule(value: unknown): SlackAppConstructor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const app = Reflect.get(value, "App");
  return isConstructorFunction<SlackAppConstructor>(app) ? app : null;
}
const INITIAL_SLACK_THREAD_HISTORY_LIMIT = 20;

function resolveSlackAppConstructor(mod: SlackBoltModule): SlackAppConstructor {
  const defaultExport =
    mod && typeof mod === "object" ? Reflect.get(mod, "default") : undefined;
  const nestedDefault =
    defaultExport && typeof defaultExport === "object"
      ? Reflect.get(defaultExport, "default")
      : undefined;

  const App =
    resolveSlackAppModule(mod) ??
    resolveSlackAppModule(defaultExport) ??
    resolveSlackAppModule(nestedDefault) ??
    (isConstructorFunction<SlackAppConstructor>(defaultExport)
      ? defaultExport
      : null);

  if (!App) {
    throw new Error(
      'Installed Slack runtime did not export constructor "App".',
    );
  }
  return App;
}

function resolveSlackWebClientModule(
  value: unknown,
): SlackWriteClientConstructor | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const webClient = Reflect.get(value, "WebClient");
  return isConstructorFunction<SlackWriteClientConstructor>(webClient)
    ? webClient
    : null;
}

function resolveSlackWebClientConstructor(
  mod: SlackWebApiModule,
): SlackWriteClientConstructor {
  const defaultExport =
    mod && typeof mod === "object" ? Reflect.get(mod, "default") : undefined;
  const nestedDefault =
    defaultExport && typeof defaultExport === "object"
      ? Reflect.get(defaultExport, "default")
      : undefined;

  const WebClient =
    resolveSlackWebClientModule(mod) ??
    resolveSlackWebClientModule(defaultExport) ??
    resolveSlackWebClientModule(nestedDefault) ??
    (isConstructorFunction<SlackWriteClientConstructor>(defaultExport)
      ? defaultExport
      : null);

  if (!WebClient) {
    throw new Error(
      'Installed Slack runtime did not export constructor "WebClient".',
    );
  }
  return WebClient;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeSlackText(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>\s*)+/, "").trim();
}

function slackTimestampToMillis(timestamp: string): number {
  return Math.round(Number.parseFloat(timestamp) * 1000);
}

function resolveSlackChatType(chatId: string): "direct" | "channel" {
  return chatId.startsWith("D") ? "direct" : "channel";
}

function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

function truncateSlackPreview(text: string, maxLength = 900): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSlackApprovalPromptText(
  event: Extract<ChannelApprovalEvent, { type: "requested" }>,
): string {
  const request = event.controlRequest.request;
  const source = event.sources[0];
  const toolName = request.tool_name || "tool";
  const inputPreview = truncateSlackPreview(
    JSON.stringify(request.input, null, 2),
  );
  const chatLabel =
    source?.chatType === "channel"
      ? "this Slack thread"
      : "this Slack conversation";
  return [
    `Permission request for ${chatLabel}`,
    "",
    `Allow the agent to run \`${toolName}\`?`,
    "",
    "```json",
    inputPreview,
    "```",
    "",
    "Choose *Approve* or *Deny* to continue.",
  ].join("\n");
}

function buildSlackApprovalResolvedText(params: {
  event: Extract<ChannelApprovalEvent, { type: "resolved" }>;
  actorId?: string;
}): string {
  const decision =
    "decision" in params.event.response ? params.event.response.decision : null;
  const actorSuffix = params.actorId ? ` by <@${params.actorId}>` : "";
  if (decision?.behavior === "allow") {
    return `Approved${actorSuffix}.`;
  }
  if (decision?.behavior === "deny") {
    return `Denied${actorSuffix}${decision.message ? `: ${decision.message}` : "."}`;
  }
  if ("error" in params.event.response) {
    return params.event.response.error
      ? `Approval is no longer available: ${params.event.response.error}`
      : "Approval is no longer available.";
  }
  return "Approval is no longer available.";
}

function buildSlackApprovalBlocks(
  requestId: string,
): Array<Record<string, unknown>> {
  return [
    {
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: {
            type: "plain_text",
            text: "Approve",
            emoji: true,
          },
          style: "primary",
          value: JSON.stringify({
            requestId,
            decision: "allow",
          } satisfies SlackBlockActionPayload),
        },
        {
          type: "button",
          action_id: SLACK_APPROVAL_ACTION_ID,
          text: {
            type: "plain_text",
            text: "Deny",
            emoji: true,
          },
          style: "danger",
          value: JSON.stringify({
            requestId,
            decision: "deny",
          } satisfies SlackBlockActionPayload),
        },
      ],
    },
  ];
}

function parseSlackApprovalActionPayload(
  value: unknown,
): { requestId: string; decision: "allow" | "deny" } | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as SlackBlockActionPayload;
    if (
      !isNonEmptyString(parsed.requestId) ||
      (parsed.decision !== "allow" && parsed.decision !== "deny")
    ) {
      return null;
    }
    return {
      requestId: parsed.requestId,
      decision: parsed.decision,
    };
  } catch {
    return null;
  }
}

const SLACK_INGRESS_DEDUPE_TTL_MS = 60_000;
const SLACK_INGRESS_DEDUPE_MAX = 2_000;
const SLACK_LIFECYCLE_STATE_TTL_MS = 6 * 60 * 60 * 1000;
const SLACK_LIFECYCLE_STATE_MAX = 2_000;
const SLACK_APPROVAL_ACTION_ID = "letta_channel_approval";

type SlackLifecycleState = "queued" | "completed" | "error" | "cancelled";

function resolveUploadMimeType(filePath: string): string | undefined {
  switch (extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
      return "text/plain";
    case ".md":
      return "text/markdown";
    default:
      return undefined;
  }
}

async function uploadSlackFile(
  slackClient: SlackWriteClient,
  msg: OutboundChannelMessage,
): Promise<{ messageId: string }> {
  if (!msg.mediaPath) {
    throw new Error("mediaPath is required for Slack file uploads.");
  }

  const buffer = await readFile(msg.mediaPath);
  const uploadFileName = msg.fileName ?? basename(msg.mediaPath);
  const uploadTitle = msg.title ?? uploadFileName;
  const uploadMimeType = resolveUploadMimeType(uploadFileName);
  const uploadUrlResp = await slackClient.files.getUploadURLExternal({
    filename: uploadFileName,
    length: buffer.length,
  });

  if (
    !uploadUrlResp.ok ||
    !uploadUrlResp.upload_url ||
    !uploadUrlResp.file_id
  ) {
    throw new Error(
      `Failed to get Slack upload URL: ${uploadUrlResp.error ?? "unknown error"}`,
    );
  }

  const uploadResp = await fetch(uploadUrlResp.upload_url, {
    method: "POST",
    ...(uploadMimeType ? { headers: { "Content-Type": uploadMimeType } } : {}),
    body: buffer,
  });
  if (!uploadResp.ok) {
    throw new Error(`Failed to upload Slack file: HTTP ${uploadResp.status}`);
  }

  const completeResp = await slackClient.files.completeUploadExternal({
    files: [{ id: uploadUrlResp.file_id, title: uploadTitle }],
    channel_id: msg.chatId,
    ...(msg.text.trim() ? { initial_comment: msg.text } : {}),
    ...((msg.threadId ?? msg.replyToMessageId)
      ? { thread_ts: msg.threadId ?? msg.replyToMessageId }
      : {}),
  });

  if (!completeResp.ok) {
    throw new Error(
      `Failed to complete Slack upload: ${completeResp.error ?? "unknown error"}`,
    );
  }

  return { messageId: uploadUrlResp.file_id };
}

function resolveSlackUserDisplayName(userInfo: unknown): string | undefined {
  const user = asRecord(asRecord(userInfo)?.user);
  const profile = asRecord(user?.profile);
  return firstNonEmptyString(
    profile?.display_name,
    profile?.real_name,
    user?.name,
  );
}

function truncateSlackThreadLabel(text: string, maxLength = 80): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function buildSlackThreadLabel(
  msg: InboundChannelMessage,
  starterText?: string,
): string | undefined {
  if (msg.chatType !== "channel") {
    return undefined;
  }

  const roomLabel =
    isNonEmptyString(msg.chatLabel) && msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";
  const preview = truncateSlackThreadLabel(starterText ?? msg.text);
  if (preview) {
    return `Slack thread${roomLabel}: ${preview}`;
  }
  return roomLabel ? `Slack thread${roomLabel}` : `Slack thread ${msg.chatId}`;
}

function buildSlackChannelContextLabel(
  msg: InboundChannelMessage,
): string | undefined {
  if (msg.chatType !== "channel") {
    return undefined;
  }

  const roomLabel =
    isNonEmptyString(msg.chatLabel) && msg.chatLabel !== msg.chatId
      ? ` in ${msg.chatLabel}`
      : "";

  return roomLabel
    ? `Slack channel context${roomLabel} before thread start`
    : `Slack channel context before thread start`;
}

export async function resolveSlackAccountDisplayName(
  botToken: string,
  appToken: string,
): Promise<string | undefined> {
  const bolt = await loadSlackBoltModule();
  const App = resolveSlackAppConstructor(bolt);
  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });
  const auth = await app.client.auth.test({ token: botToken });
  if (isNonEmptyString(auth.user_id)) {
    try {
      const userInfo = await app.client.users.info({
        token: botToken,
        user: auth.user_id,
      });
      const displayName = resolveSlackUserDisplayName(userInfo);
      if (displayName) {
        return displayName;
      }
    } catch {}
  }
  return isNonEmptyString(auth.user) ? auth.user : undefined;
}

export function createSlackAdapter(
  config: SlackChannelAccount,
): ChannelAdapter {
  let app: SlackApp | null = null;
  let writeClient: SlackWriteClient | null = null;
  let running = false;
  let botUserId: string | null = null;
  const knownThreadIdsByMessageId = new Map<string, string | null>();
  const knownUserDisplayNames = new Map<string, string>();
  const seenIngressMessageKeys = new Map<string, number>();
  const lifecycleStateByMessageKey = new Map<
    string,
    { state: SlackLifecycleState; updatedAt: number }
  >();
  const lifecycleOperationByMessageKey = new Map<string, Promise<void>>();
  const approvalPromptByRequestId = new Map<string, SlackApprovalPromptState>();

  function buildIngressMessageKey(
    channelId: string | undefined,
    messageId: string | undefined,
  ): string | null {
    if (!isNonEmptyString(channelId) || !isNonEmptyString(messageId)) {
      return null;
    }
    return `${channelId}:${messageId}`;
  }

  function pruneSeenIngressMessageKeys(now: number = Date.now()): void {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) {
        seenIngressMessageKeys.delete(key);
      }
    }

    if (seenIngressMessageKeys.size <= SLACK_INGRESS_DEDUPE_MAX) {
      return;
    }

    const oldestEntries = Array.from(seenIngressMessageKeys.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflowCount =
      seenIngressMessageKeys.size - SLACK_INGRESS_DEDUPE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        seenIngressMessageKeys.delete(entry[0]);
      }
    }
  }

  function getLifecycleMessageKey(source: ChannelTurnSource): string | null {
    if (
      source.channel !== "slack" ||
      !isNonEmptyString(source.chatId) ||
      !isNonEmptyString(source.messageId)
    ) {
      return null;
    }
    return `${source.chatId}:${source.messageId}`;
  }

  function pruneLifecycleState(now: number = Date.now()): void {
    for (const [key, entry] of lifecycleStateByMessageKey) {
      if (entry.updatedAt + SLACK_LIFECYCLE_STATE_TTL_MS <= now) {
        lifecycleStateByMessageKey.delete(key);
      }
    }

    if (lifecycleStateByMessageKey.size <= SLACK_LIFECYCLE_STATE_MAX) {
      return;
    }

    const oldestEntries = Array.from(lifecycleStateByMessageKey.entries()).sort(
      (a, b) => a[1].updatedAt - b[1].updatedAt,
    );
    const overflowCount =
      lifecycleStateByMessageKey.size - SLACK_LIFECYCLE_STATE_MAX;
    for (let index = 0; index < overflowCount; index += 1) {
      const entry = oldestEntries[index];
      if (entry) {
        lifecycleStateByMessageKey.delete(entry[0]);
      }
    }
  }

  async function sendLifecycleReaction(
    source: ChannelTurnSource,
    emoji: string,
    removeReaction = false,
  ): Promise<void> {
    if (!isNonEmptyString(source.messageId)) {
      return;
    }
    await ensureApp();
    const slackClient = await ensureWriteClient();
    if (removeReaction) {
      await slackClient.reactions.remove({
        channel: source.chatId,
        timestamp: source.messageId,
        name: emoji,
      });
      return;
    }
    await slackClient.reactions.add({
      channel: source.chatId,
      timestamp: source.messageId,
      name: emoji,
    });
  }

  function scheduleLifecycleTransition(
    source: ChannelTurnSource,
    nextState: SlackLifecycleState,
  ): Promise<void> | null {
    const key = getLifecycleMessageKey(source);
    if (!key) {
      return null;
    }

    const previous =
      lifecycleOperationByMessageKey.get(key) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        pruneLifecycleState();
        const currentState = lifecycleStateByMessageKey.get(key)?.state;
        if (currentState === nextState) {
          lifecycleStateByMessageKey.set(key, {
            state: nextState,
            updatedAt: Date.now(),
          });
          return;
        }

        if (nextState === "queued") {
          if (!currentState) {
            await sendLifecycleReaction(source, "eyes");
            lifecycleStateByMessageKey.set(key, {
              state: nextState,
              updatedAt: Date.now(),
            });
          }
          return;
        }

        if (currentState === "queued") {
          try {
            await sendLifecycleReaction(source, "eyes", true);
          } catch {}
        }

        await sendLifecycleReaction(
          source,
          nextState === "completed" ? "white_check_mark" : "x",
        );
        lifecycleStateByMessageKey.set(key, {
          state: nextState,
          updatedAt: Date.now(),
        });
      })
      .catch((error) => {
        console.warn(
          `[Slack] Failed to update lifecycle reaction for ${key}:`,
          error instanceof Error ? error.message : error,
        );
      })
      .finally(() => {
        if (lifecycleOperationByMessageKey.get(key) === operation) {
          lifecycleOperationByMessageKey.delete(key);
        }
      });

    lifecycleOperationByMessageKey.set(key, operation);
    return operation;
  }

  function markIngressMessageSeen(
    channelId: string | undefined,
    messageId: string | undefined,
  ): boolean {
    const key = buildIngressMessageKey(channelId, messageId);
    if (!key) {
      return false;
    }

    const now = Date.now();
    pruneSeenIngressMessageKeys(now);

    if (seenIngressMessageKeys.has(key)) {
      return true;
    }

    seenIngressMessageKeys.set(key, now + SLACK_INGRESS_DEDUPE_TTL_MS);
    return false;
  }

  function hasSlackMention(text: string, userId: string | null): boolean {
    if (!isNonEmptyString(text) || !isNonEmptyString(userId)) {
      return false;
    }

    return text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`);
  }

  function rememberMessageThread(
    messageId: string | undefined,
    threadId: string | null,
  ): void {
    if (!isNonEmptyString(messageId)) {
      return;
    }
    knownThreadIdsByMessageId.set(messageId, threadId);
  }

  function resolveApprovalTargetThreadId(
    source: ChannelTurnSource,
  ): string | null {
    return source.threadId ?? source.messageId ?? null;
  }

  async function resolveUserName(
    slackApp: SlackApp,
    userId: string | undefined,
  ): Promise<string | undefined> {
    if (!isNonEmptyString(userId)) {
      return undefined;
    }

    const cached = knownUserDisplayNames.get(userId);
    if (cached) {
      return cached;
    }

    try {
      const userInfo = await slackApp.client.users.info({ user: userId });
      const displayName = resolveSlackUserDisplayName(userInfo);
      if (displayName) {
        knownUserDisplayNames.set(userId, displayName);
        return displayName;
      }
    } catch {}

    knownUserDisplayNames.set(userId, userId);
    return userId;
  }

  async function ensureApp(): Promise<SlackApp> {
    if (app) {
      return app;
    }

    const bolt = await loadSlackBoltModule();
    const App = resolveSlackAppConstructor(bolt);
    const instance = new App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: true,
    });

    instance.error(async (error) => {
      console.error("[Slack] Unhandled app error:", error);
    });

    instance.message(async ({ message }) => {
      if (!adapter.onMessage) {
        return;
      }

      const rawMessage = asRecord(message);
      if (!rawMessage) {
        return;
      }

      const channelId = rawMessage.channel;
      if (!isNonEmptyString(channelId)) {
        return;
      }

      if (
        (isNonEmptyString(rawMessage.subtype) &&
          rawMessage.subtype !== "file_share") ||
        isNonEmptyString(rawMessage.bot_id) ||
        !isNonEmptyString(rawMessage.user) ||
        !isNonEmptyString(rawMessage.ts)
      ) {
        return;
      }

      const text = isNonEmptyString(rawMessage.text) ? rawMessage.text : "";
      const wasMentioned = hasSlackMention(text, botUserId);
      const attachments = await resolveSlackInboundAttachments({
        accountId: config.accountId,
        token: config.botToken,
        rawEvent: message,
      });
      const chatType = resolveSlackChatType(channelId);
      const threadId =
        chatType === "channel"
          ? (firstNonEmptyString(rawMessage.thread_ts, rawMessage.ts) ?? null)
          : null;
      rememberMessageThread(rawMessage.ts, threadId);
      const senderName = await resolveUserName(instance, rawMessage.user);

      if (chatType === "direct") {
        if (markIngressMessageSeen(channelId, rawMessage.ts)) {
          return;
        }

        const inbound: InboundChannelMessage = {
          channel: "slack",
          accountId: config.accountId,
          chatId: channelId,
          senderId: rawMessage.user,
          senderName,
          text,
          timestamp: slackTimestampToMillis(rawMessage.ts),
          messageId: rawMessage.ts,
          threadId: null,
          chatType: "direct",
          isMention: wasMentioned,
          attachments,
          raw: message,
        };

        try {
          await adapter.onMessage(inbound);
        } catch (error) {
          console.error("[Slack] Error handling DM message:", error);
        }
        return;
      }

      if (!isNonEmptyString(rawMessage.thread_ts)) {
        return;
      }

      if (markIngressMessageSeen(channelId, rawMessage.ts)) {
        return;
      }

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: channelId,
        senderId: rawMessage.user,
        senderName,
        chatLabel: channelId,
        text: wasMentioned ? normalizeSlackText(text) : text,
        timestamp: slackTimestampToMillis(rawMessage.ts),
        messageId: rawMessage.ts,
        threadId,
        chatType: "channel",
        isMention: wasMentioned,
        attachments,
        raw: message,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error(
          "[Slack] Error handling threaded channel message:",
          error,
        );
      }
    });

    instance.event("app_mention", async ({ event }) => {
      if (!adapter.onMessage) {
        return;
      }

      if (
        !isNonEmptyString(event.channel) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.ts)
      ) {
        return;
      }

      if (markIngressMessageSeen(event.channel, event.ts)) {
        return;
      }

      rememberMessageThread(event.ts, event.thread_ts ?? event.ts);

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId: event.channel,
        senderId: event.user,
        senderName: await resolveUserName(instance, event.user),
        chatLabel: event.channel,
        text: normalizeSlackText(event.text ?? ""),
        timestamp: slackTimestampToMillis(event.ts),
        messageId: event.ts,
        threadId: event.thread_ts ?? event.ts,
        chatType: "channel",
        isMention: true,
        attachments: await resolveSlackInboundAttachments({
          accountId: config.accountId,
          token: config.botToken,
          rawEvent: event,
        }),
        raw: event,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error("[Slack] Error handling channel mention:", error);
      }
    });

    const handleReactionEvent = async (
      event: SlackReactionEvent,
      action: "added" | "removed",
    ) => {
      if (!adapter.onMessage) {
        return;
      }

      const item = asRecord(event.item);
      const chatId = item?.channel;
      const targetMessageId = item?.ts;
      if (
        item?.type !== "message" ||
        !isNonEmptyString(chatId) ||
        !isNonEmptyString(targetMessageId) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.reaction)
      ) {
        return;
      }

      const chatType = resolveSlackChatType(chatId);
      const threadId =
        chatType === "channel"
          ? (knownThreadIdsByMessageId.get(targetMessageId) ?? targetMessageId)
          : null;

      const inbound: InboundChannelMessage = {
        channel: "slack",
        accountId: config.accountId,
        chatId,
        senderId: event.user,
        senderName: await resolveUserName(instance, event.user),
        chatLabel: chatId,
        text: `Slack reaction ${action}: :${event.reaction}:`,
        timestamp: slackTimestampToMillis(
          firstNonEmptyString(event.event_ts, targetMessageId) ??
            targetMessageId,
        ),
        messageId: firstNonEmptyString(event.event_ts, targetMessageId),
        threadId,
        chatType,
        isMention: false,
        reaction: {
          action,
          emoji: event.reaction,
          targetMessageId,
          targetSenderId: isNonEmptyString(event.item_user)
            ? event.item_user
            : undefined,
        },
        raw: event,
      };

      try {
        await adapter.onMessage(inbound);
      } catch (error) {
        console.error(`[Slack] Error handling reaction ${action}:`, error);
      }
    };

    instance.event("reaction_added", async ({ event }) => {
      await handleReactionEvent(event as SlackReactionEvent, "added");
    });

    instance.event("reaction_removed", async ({ event }) => {
      await handleReactionEvent(event as SlackReactionEvent, "removed");
    });

    instance.action(SLACK_APPROVAL_ACTION_ID, async ({ ack, body, action }) => {
      await ack();

      if (!adapter.onApprovalResponse) {
        return;
      }

      const parsed = parseSlackApprovalActionPayload(asRecord(action)?.value);
      if (!parsed) {
        return;
      }

      const promptState = approvalPromptByRequestId.get(parsed.requestId);
      if (!promptState) {
        return;
      }

      const actorId = firstNonEmptyString(asRecord(asRecord(body)?.user)?.id);
      if (
        promptState.allowedSenderIds.size > 0 &&
        (!actorId || !promptState.allowedSenderIds.has(actorId))
      ) {
        try {
          const slackClient = await ensureWriteClient();
          if (actorId) {
            await slackClient.chat.postEphemeral({
              channel: promptState.chatId,
              user: actorId,
              text: "Only the person who triggered this request can approve or deny it.",
              ...(promptState.threadId
                ? { thread_ts: promptState.threadId }
                : {}),
            });
          }
        } catch {}
        return;
      }

      const accepted = await adapter.onApprovalResponse({
        requestId: parsed.requestId,
        decision:
          parsed.decision === "allow"
            ? {
                behavior: "allow",
                message: actorId
                  ? `Approved from Slack by ${actorId}`
                  : "Approved from Slack",
              }
            : {
                behavior: "deny",
                message: actorId
                  ? `Denied from Slack by ${actorId}`
                  : "Denied from Slack",
              },
      });

      if (accepted || !actorId) {
        return;
      }

      try {
        const slackClient = await ensureWriteClient();
        await slackClient.chat.postEphemeral({
          channel: promptState.chatId,
          user: actorId,
          text: "That approval request is no longer available.",
          ...(promptState.threadId ? { thread_ts: promptState.threadId } : {}),
        });
      } catch {}
    });

    app = instance;
    return instance;
  }

  async function ensureWriteClient(): Promise<SlackWriteClient> {
    if (writeClient) {
      return writeClient;
    }

    const webApi = await loadSlackWebApiModule();
    const WebClient = resolveSlackWebClientConstructor(webApi);
    writeClient = new WebClient(config.botToken, {
      retryConfig: {
        retries: 0,
      },
    });
    return writeClient;
  }

  const adapter: ChannelAdapter = {
    id: `slack:${config.accountId}`,
    channelId: "slack",
    accountId: config.accountId,
    name: "Slack",

    async start(): Promise<void> {
      if (running) {
        return;
      }

      const slackApp = await ensureApp();
      const auth = await slackApp.client.auth.test();
      botUserId = isNonEmptyString(auth.user_id) ? auth.user_id : null;
      await slackApp.start();
      running = true;

      console.log(
        `[Slack] App started for workspace ${auth.team ?? "unknown"} (dm_policy: ${config.dmPolicy})`,
      );
    },

    async stop(): Promise<void> {
      if (!app || !running) {
        return;
      }
      await app.stop();
      running = false;
      app = null;
      writeClient = null;
      botUserId = null;
      seenIngressMessageKeys.clear();
      lifecycleStateByMessageKey.clear();
      lifecycleOperationByMessageKey.clear();
      approvalPromptByRequestId.clear();
      console.log("[Slack] App stopped");
    },

    isRunning(): boolean {
      return running;
    },

    async handleTurnLifecycleEvent(
      event: ChannelTurnLifecycleEvent,
    ): Promise<void> {
      if (!running) {
        return;
      }

      if (event.type === "queued") {
        await scheduleLifecycleTransition(event.source, "queued");
        return;
      }

      if (event.type === "processing") {
        return;
      }

      const nextState: SlackLifecycleState =
        event.outcome === "completed"
          ? "completed"
          : event.outcome === "cancelled"
            ? "cancelled"
            : "error";

      await Promise.all(
        event.sources.map((source) =>
          scheduleLifecycleTransition(source, nextState),
        ),
      );
    },

    async handleApprovalEvent(event: ChannelApprovalEvent): Promise<void> {
      if (!running) {
        return;
      }

      await ensureApp();
      const slackClient = await ensureWriteClient();

      if (event.type === "requested") {
        if (approvalPromptByRequestId.has(event.controlRequest.request_id)) {
          return;
        }

        const source = event.sources[0];
        if (!source) {
          return;
        }

        const threadId = resolveApprovalTargetThreadId(source);
        const response = await slackClient.chat.postMessage({
          channel: source.chatId,
          text: buildSlackApprovalPromptText(event),
          ...(threadId ? { thread_ts: threadId } : {}),
          blocks: buildSlackApprovalBlocks(event.controlRequest.request_id),
        });

        if (!isNonEmptyString(response.ts)) {
          return;
        }

        approvalPromptByRequestId.set(event.controlRequest.request_id, {
          chatId: source.chatId,
          threadId,
          messageTs: response.ts,
          allowedSenderIds: new Set(
            event.sources
              .map((entry) => entry.senderId)
              .filter((value): value is string => isNonEmptyString(value)),
          ),
        });
        return;
      }

      const promptState = approvalPromptByRequestId.get(
        event.controlRequest.request_id,
      );
      if (!promptState) {
        return;
      }

      const actorId =
        "decision" in event.response &&
        typeof event.response.decision?.message === "string"
          ? event.response.decision.message.match(
              /(?:Approved|Denied) from Slack by ([A-Z0-9]+)/i,
            )?.[1]
          : undefined;

      await slackClient.chat.update({
        channel: promptState.chatId,
        ts: promptState.messageTs,
        text: buildSlackApprovalResolvedText({ event, actorId }),
        blocks: [],
      });
      approvalPromptByRequestId.delete(event.controlRequest.request_id);
    },

    async sendMessage(
      msg: OutboundChannelMessage,
    ): Promise<{ messageId: string }> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      if (msg.reaction) {
        const targetMessageId = msg.targetMessageId ?? msg.replyToMessageId;
        if (!targetMessageId) {
          throw new Error(
            "Slack reactions require message_id (or reply_to_message_id) to identify the target message.",
          );
        }
        const emoji = normalizeSlackReactionName(msg.reaction);
        if (!emoji) {
          throw new Error("Slack reaction emoji cannot be empty.");
        }
        if (msg.removeReaction) {
          await slackClient.reactions.remove({
            channel: msg.chatId,
            timestamp: targetMessageId,
            name: emoji,
          });
        } else {
          await slackClient.reactions.add({
            channel: msg.chatId,
            timestamp: targetMessageId,
            name: emoji,
          });
        }
        return { messageId: targetMessageId };
      }

      if (msg.mediaPath) {
        return uploadSlackFile(slackClient, msg);
      }

      const response = await slackClient.chat.postMessage({
        channel: msg.chatId,
        text: msg.text,
        ...((msg.threadId ?? msg.replyToMessageId)
          ? { thread_ts: msg.threadId ?? msg.replyToMessageId }
          : {}),
      });

      rememberMessageThread(
        response.ts,
        msg.threadId ?? msg.replyToMessageId ?? response.ts ?? null,
      );

      return { messageId: response.ts ?? "" };
    },

    async sendDirectReply(
      chatId: string,
      text: string,
      options?: { replyToMessageId?: string },
    ): Promise<void> {
      await ensureApp();
      const slackClient = await ensureWriteClient();
      const response = await slackClient.chat.postMessage({
        channel: chatId,
        text,
        ...(options?.replyToMessageId
          ? { thread_ts: options.replyToMessageId }
          : {}),
      });
      rememberMessageThread(
        response.ts,
        options?.replyToMessageId ?? response.ts ?? null,
      );
    },

    async prepareInboundMessage(
      msg: InboundChannelMessage,
      options?: { isFirstRouteTurn?: boolean },
    ): Promise<InboundChannelMessage> {
      if (
        !options?.isFirstRouteTurn ||
        msg.channel !== "slack" ||
        msg.chatType !== "channel" ||
        !isNonEmptyString(msg.threadId) ||
        !isNonEmptyString(msg.messageId)
      ) {
        return msg;
      }

      const shouldHydrateExistingThreadContext = msg.threadId !== msg.messageId;
      const shouldHydrateChannelBootstrapContext =
        msg.isMention === true && msg.threadId === msg.messageId;

      if (
        !shouldHydrateExistingThreadContext &&
        !shouldHydrateChannelBootstrapContext
      ) {
        return msg;
      }

      const slackApp = await ensureApp();
      const starter = shouldHydrateExistingThreadContext
        ? await resolveSlackThreadStarter({
            channelId: msg.chatId,
            threadTs: msg.threadId,
            client: slackApp.client,
          })
        : null;
      const history = shouldHydrateExistingThreadContext
        ? await resolveSlackThreadHistory({
            channelId: msg.chatId,
            threadTs: msg.threadId,
            client: slackApp.client,
            currentMessageTs: msg.messageId,
            limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
          })
        : await resolveSlackChannelHistory({
            channelId: msg.chatId,
            beforeTs: msg.messageId,
            client: slackApp.client,
            limit: INITIAL_SLACK_THREAD_HISTORY_LIMIT,
          });

      if (!starter && history.length === 0) {
        return msg;
      }

      const uniqueUserIds = new Set<string>();
      if (isNonEmptyString(starter?.userId)) {
        uniqueUserIds.add(starter.userId);
      }
      for (const entry of history) {
        if (isNonEmptyString(entry.userId)) {
          uniqueUserIds.add(entry.userId);
        }
      }

      await Promise.all(
        Array.from(uniqueUserIds).map(async (userId) => {
          await resolveUserName(slackApp, userId);
        }),
      );

      const resolveThreadSenderName = (
        userId?: string,
        botId?: string,
      ): string | undefined => {
        if (isNonEmptyString(userId)) {
          return knownUserDisplayNames.get(userId) ?? userId;
        }
        if (isNonEmptyString(botId)) {
          return `Bot (${botId})`;
        }
        return undefined;
      };

      return {
        ...msg,
        threadContext: {
          label: shouldHydrateExistingThreadContext
            ? buildSlackThreadLabel(msg, starter?.text)
            : buildSlackChannelContextLabel(msg),
          ...(starter
            ? {
                starter: {
                  messageId: starter.ts,
                  senderId: starter.userId ?? starter.botId,
                  senderName: resolveThreadSenderName(
                    starter.userId,
                    starter.botId,
                  ),
                  text: starter.text,
                },
              }
            : {}),
          ...(history.length > 0
            ? {
                history: history.map((entry) => ({
                  messageId: entry.ts,
                  senderId: entry.userId ?? entry.botId,
                  senderName: resolveThreadSenderName(
                    entry.userId,
                    entry.botId,
                  ),
                  text: entry.text,
                })),
              }
            : {}),
        },
      };
    },

    onMessage: undefined,
  };

  return adapter;
}
