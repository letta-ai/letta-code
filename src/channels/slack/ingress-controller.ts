import type SlackApp from "@slack/bolt";
import { listChannelSlashCommands } from "@/channels/commands";
import { SLACK_MODEL_SELECT_ACTION_ID } from "@/channels/slack/model-picker-blocks";
import type {
  ChannelAdapter,
  InboundChannelMessage,
  SlackChannelAccount,
} from "@/channels/types";
import type { AgentThreadTracker } from "./agent-thread-tracker";
import type { SlackInboundDebounceController } from "./inbound-debounce";
import type {
  SlackCommandPayload,
  SlackDebounceRawInput,
  SlackReactionEvent,
} from "./internal-types";
import { resolveSlackInboundAttachments } from "./media";
import {
  asRecord,
  firstNonEmptyString,
  getSlackActionRecord,
  hasSlackMention,
  isNonEmptyString,
  isProcessableSlackInboundMessage,
  normalizeSlackText,
  resolveSlackActionChannelId,
  resolveSlackActionMessageId,
  resolveSlackActionThreadId,
  resolveSlackActionUser,
  resolveSlackChatType,
  resolveSlackSelectedModel,
  resolveSlackSenderTeamId,
  resolveSlackUserDisplayName,
  slackTimestampToMillis,
} from "./utils";

const SLACK_INGRESS_DEDUPE_TTL_MS = 60_000;
const SLACK_INGRESS_DEDUPE_MAX = 2_000;

export type SlackIngressController = {
  register: (app: SlackApp) => void;
  rememberMessageThread: (
    messageId: string | undefined,
    threadId: string | null,
  ) => void;
  resolveKnownThreadRoot: (messageId: string) => string;
  resolveUserName: (
    app: SlackApp,
    userId: string | undefined,
  ) => Promise<string | undefined>;
  getKnownUserDisplayName: (userId: string) => string | undefined;
  clear: () => void;
};

export function createSlackIngressController(params: {
  config: SlackChannelAccount;
  getAdapter: () => ChannelAdapter;
  getBotUserId: () => string | null;
  agentThreadTracker: AgentThreadTracker;
  debounce: SlackInboundDebounceController;
}): SlackIngressController {
  const { config } = params;
  const knownThreadIdsByMessageId = new Map<string, string | null>();
  const knownUserDisplayNames = new Map<string, string>();
  const seenIngressMessageKeys = new Map<string, number>();

  function pruneSeenIngress(now: number = Date.now()): void {
    for (const [key, expiresAt] of seenIngressMessageKeys) {
      if (expiresAt <= now) seenIngressMessageKeys.delete(key);
    }
    if (seenIngressMessageKeys.size <= SLACK_INGRESS_DEDUPE_MAX) return;
    const oldest = Array.from(seenIngressMessageKeys.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    const overflow = seenIngressMessageKeys.size - SLACK_INGRESS_DEDUPE_MAX;
    for (let index = 0; index < overflow; index += 1) {
      const entry = oldest[index];
      if (entry) seenIngressMessageKeys.delete(entry[0]);
    }
  }

  function markIngressMessageSeen(
    channelId: string | undefined,
    messageId: string | undefined,
  ): boolean {
    if (!isNonEmptyString(channelId) || !isNonEmptyString(messageId)) {
      return false;
    }
    const key = `${channelId}:${messageId}`;
    pruneSeenIngress();
    if (seenIngressMessageKeys.has(key)) return true;
    seenIngressMessageKeys.set(key, Date.now() + SLACK_INGRESS_DEDUPE_TTL_MS);
    return false;
  }

  function rememberMessageThread(
    messageId: string | undefined,
    threadId: string | null,
  ): void {
    if (isNonEmptyString(messageId)) {
      knownThreadIdsByMessageId.set(messageId, threadId);
    }
  }

  async function resolveUserName(
    app: SlackApp,
    userId: string | undefined,
  ): Promise<string | undefined> {
    if (!isNonEmptyString(userId)) return undefined;
    const cached = knownUserDisplayNames.get(userId);
    if (cached) return cached;
    try {
      const displayName = resolveSlackUserDisplayName(
        await app.client.users.info({ user: userId }),
      );
      if (displayName) {
        knownUserDisplayNames.set(userId, displayName);
        return displayName;
      }
    } catch {}
    knownUserDisplayNames.set(userId, userId);
    return userId;
  }

  async function dispatchInbound(
    inbound: InboundChannelMessage,
    raw: SlackDebounceRawInput,
    source: "message" | "app_mention",
    wasMentioned: boolean,
    errorLabel: string,
  ): Promise<void> {
    try {
      await params.debounce.dispatch({
        inbound,
        raw,
        opts: { source, wasMentioned },
      });
    } catch (error) {
      console.error(`[Slack] Error handling ${errorLabel}:`, error);
    }
  }

  function register(app: SlackApp): void {
    app.message(async ({ message }) => {
      if (!params.getAdapter().onMessage) return;
      const rawMessage = asRecord(message);
      const channelId = rawMessage?.channel;
      if (
        !rawMessage ||
        !isNonEmptyString(channelId) ||
        !isProcessableSlackInboundMessage(rawMessage)
      ) {
        return;
      }

      const text = isNonEmptyString(rawMessage.text) ? rawMessage.text : "";
      const wasMentioned = hasSlackMention(text, params.getBotUserId());
      const attachments = await resolveSlackInboundAttachments({
        accountId: config.accountId,
        token: config.botToken,
        rawEvent: message,
        transcribeVoice: config.transcribeVoice === true,
      });
      const chatType = resolveSlackChatType(channelId);
      const threadId =
        chatType === "direct"
          ? (firstNonEmptyString(rawMessage.thread_ts) ?? null)
          : (firstNonEmptyString(rawMessage.thread_ts, rawMessage.ts) ?? null);
      rememberMessageThread(rawMessage.ts, threadId);
      const senderName = await resolveUserName(app, rawMessage.user);
      const isAgentThread =
        chatType === "channel" &&
        isNonEmptyString(threadId) &&
        params.agentThreadTracker.has(channelId, threadId);
      const effectiveMention = wasMentioned || isAgentThread;

      if (chatType === "direct") {
        const seenKey = `${channelId}:${rawMessage.ts}`;
        if (markIngressMessageSeen(channelId, rawMessage.ts)) return;
        params.debounce.rememberAppMentionRetry(seenKey);
        await dispatchInbound(
          {
            channel: "slack",
            accountId: config.accountId,
            chatId: channelId,
            senderId: rawMessage.user,
            senderTeamId: resolveSlackSenderTeamId(rawMessage),
            senderName,
            text: wasMentioned ? normalizeSlackText(text) : text,
            timestamp: slackTimestampToMillis(rawMessage.ts),
            messageId: rawMessage.ts,
            threadId,
            chatType: "direct",
            isMention: wasMentioned,
            attachments,
            raw: message,
          },
          rawMessage as SlackDebounceRawInput,
          "message",
          wasMentioned,
          "DM message",
        );
        return;
      }

      if (!isNonEmptyString(rawMessage.thread_ts)) return;
      const seenKey = `${channelId}:${rawMessage.ts}`;
      if (markIngressMessageSeen(channelId, rawMessage.ts)) return;
      params.debounce.rememberAppMentionRetry(seenKey);
      await dispatchInbound(
        {
          channel: "slack",
          accountId: config.accountId,
          chatId: channelId,
          senderId: rawMessage.user,
          senderTeamId: resolveSlackSenderTeamId(rawMessage),
          senderName,
          chatLabel: channelId,
          text: wasMentioned ? normalizeSlackText(text) : text,
          timestamp: slackTimestampToMillis(rawMessage.ts),
          messageId: rawMessage.ts,
          threadId,
          chatType: "channel",
          isMention: effectiveMention,
          attachments,
          raw: message,
        },
        rawMessage as SlackDebounceRawInput,
        "message",
        effectiveMention,
        "threaded channel message",
      );
    });

    app.event("app_mention", async ({ event }) => {
      if (
        !params.getAdapter().onMessage ||
        !isNonEmptyString(event.channel) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.ts)
      ) {
        return;
      }
      const seenKey = `${event.channel}:${event.ts}`;
      if (
        markIngressMessageSeen(event.channel, event.ts) &&
        !params.debounce.consumeAppMentionRetry(seenKey)
      ) {
        return;
      }
      rememberMessageThread(event.ts, event.thread_ts ?? event.ts);
      await dispatchInbound(
        {
          channel: "slack",
          accountId: config.accountId,
          chatId: event.channel,
          senderId: event.user,
          senderTeamId: resolveSlackSenderTeamId(event),
          senderName: await resolveUserName(app, event.user),
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
            transcribeVoice: config.transcribeVoice === true,
          }),
          raw: event,
        },
        event as SlackDebounceRawInput,
        "app_mention",
        true,
        "channel mention",
      );
    });

    const handleCommand = async ({
      command,
      ack,
    }: {
      command: SlackCommandPayload;
      ack: () => Promise<void>;
    }) => {
      await ack();
      const adapter = params.getAdapter();
      if (
        !adapter.onMessage ||
        !isNonEmptyString(command.command) ||
        !isNonEmptyString(command.channel_id) ||
        !isNonEmptyString(command.user_id)
      ) {
        return;
      }
      const args = isNonEmptyString(command.text) ? command.text.trim() : "";
      try {
        await adapter.onMessage({
          channel: "slack",
          accountId: config.accountId,
          chatId: command.channel_id,
          senderId: command.user_id,
          senderTeamId: firstNonEmptyString(command.team_id),
          senderName: firstNonEmptyString(command.user_name, command.user_id),
          chatLabel: firstNonEmptyString(
            command.channel_name,
            command.channel_id,
          ),
          text: args ? `${command.command} ${args}` : command.command,
          timestamp: Date.now(),
          messageId: firstNonEmptyString(command.trigger_id, command.command),
          threadId: null,
          chatType: resolveSlackChatType(command.channel_id),
          isMention: false,
          raw: command,
        });
      } catch (error) {
        console.error(
          `[Slack] Error handling ${command.command} command:`,
          error,
        );
      }
    };
    for (const definition of listChannelSlashCommands()) {
      for (const name of [definition.name, ...(definition.aliases ?? [])]) {
        app.command(`/${name}`, handleCommand);
      }
    }

    const actionRegistrar = app as unknown as {
      action?: (
        actionId: string,
        handler: (args: {
          body: unknown;
          action: unknown;
          ack: () => Promise<void>;
        }) => Promise<void>,
      ) => void;
    };
    actionRegistrar.action?.(
      SLACK_MODEL_SELECT_ACTION_ID,
      async ({ body, action, ack }) => {
        await ack();
        const adapter = params.getAdapter();
        const selectedModel = resolveSlackSelectedModel(action, body);
        const channelId = resolveSlackActionChannelId(body);
        const user = resolveSlackActionUser(body);
        if (!adapter.onMessage || !selectedModel || !channelId || !user.id) {
          return;
        }
        const actionRecord = getSlackActionRecord(action, body);
        try {
          await adapter.onMessage({
            channel: "slack",
            accountId: config.accountId,
            chatId: channelId,
            senderId: user.id,
            senderTeamId: user.teamId,
            senderName: user.name,
            chatLabel: channelId,
            text: `/model ${selectedModel}`,
            timestamp: Date.now(),
            messageId: firstNonEmptyString(
              actionRecord?.action_ts,
              resolveSlackActionMessageId(body),
            ),
            threadId: resolveSlackActionThreadId(body),
            chatType: resolveSlackChatType(channelId),
            isMention: false,
            raw: body,
          });
        } catch (error) {
          console.error("[Slack] Error handling model select action:", error);
        }
      },
    );

    const handleReaction = async (
      event: SlackReactionEvent,
      action: "added" | "removed",
    ) => {
      const adapter = params.getAdapter();
      const item = asRecord(event.item);
      const chatId = item?.channel;
      const targetMessageId = item?.ts;
      if (
        !adapter.onMessage ||
        item?.type !== "message" ||
        !isNonEmptyString(chatId) ||
        !isNonEmptyString(targetMessageId) ||
        !isNonEmptyString(event.user) ||
        !isNonEmptyString(event.reaction) ||
        event.user === params.getBotUserId()
      ) {
        return;
      }
      const chatType = resolveSlackChatType(chatId);
      const threadId =
        chatType === "channel"
          ? (knownThreadIdsByMessageId.get(targetMessageId) ?? targetMessageId)
          : (knownThreadIdsByMessageId.get(targetMessageId) ?? null);
      try {
        await adapter.onMessage({
          channel: "slack",
          accountId: config.accountId,
          chatId,
          senderId: event.user,
          senderTeamId: resolveSlackSenderTeamId(event),
          senderName: await resolveUserName(app, event.user),
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
        });
      } catch (error) {
        console.error(`[Slack] Error handling reaction ${action}:`, error);
      }
    };
    app.event("reaction_added", async ({ event }) => {
      await handleReaction(event as SlackReactionEvent, "added");
    });
    app.event("reaction_removed", async ({ event }) => {
      await handleReaction(event as SlackReactionEvent, "removed");
    });
  }

  return {
    register,
    rememberMessageThread,
    resolveKnownThreadRoot: (messageId) =>
      knownThreadIdsByMessageId.get(messageId) ?? messageId,
    resolveUserName,
    getKnownUserDisplayName: (userId) => knownUserDisplayNames.get(userId),
    clear(): void {
      seenIngressMessageKeys.clear();
      knownThreadIdsByMessageId.clear();
      knownUserDisplayNames.clear();
    },
  };
}
