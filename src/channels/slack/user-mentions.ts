import type { ChannelUserMention } from "@/channels/message-references";
import type {
  ChannelReplyContext,
  ChannelThreadContextEntry,
  InboundChannelMessage,
} from "@/channels/types";

const SLACK_USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const MAX_SLACK_DISPLAY_NAME_LENGTH = 80;

interface SlackUserMentionToken {
  start: number;
  end: number;
  userId: string;
}

type ResolveSlackUserName = (userId: string) => Promise<string | undefined>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripSlackBotMention(
  text: string,
  botUserId: string | null | undefined,
): string {
  if (!botUserId) return text.trim();
  const botMentionPattern = new RegExp(
    `^\\s*<@${escapeRegExp(botUserId)}(?:\\|[^>]*)?>`,
  );
  return text.replace(botMentionPattern, "").trim();
}

export function sanitizeSlackUserDisplayName(
  value: string | undefined,
  fallbackUserId: string,
): string {
  const sanitized = (value ?? "")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_SLACK_DISPLAY_NAME_LENGTH)
    .trim();
  return sanitized || fallbackUserId;
}

function extractSlackUserMentionTokens(
  text: string | undefined,
): SlackUserMentionToken[] {
  if (!text?.includes("<@")) return [];
  return Array.from(text.matchAll(SLACK_USER_MENTION_PATTERN), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    userId: match[1] ?? "",
  })).filter((mention) => mention.userId.length > 0);
}

function buildChannelUserMentions(
  text: string | undefined,
  displayNames: ReadonlyMap<string, string>,
): ChannelUserMention[] | undefined {
  const mentions = extractSlackUserMentionTokens(text).map((mention) => ({
    ...mention,
    displayName: displayNames.get(mention.userId) ?? mention.userId,
  }));
  return mentions.length > 0 ? mentions : undefined;
}

function collectMentionUserIds(msg: InboundChannelMessage): string[] {
  const ids = new Set<string>();
  const collect = (text: string | undefined): void => {
    for (const mention of extractSlackUserMentionTokens(text)) {
      ids.add(mention.userId);
    }
  };
  collect(msg.text);
  collect(msg.replyContext?.text);
  collect(msg.threadContext?.starter?.text);
  for (const entry of msg.threadContext?.history ?? []) collect(entry.text);
  return [...ids];
}

function withResolvedReplyMentions(
  replyContext: ChannelReplyContext | undefined,
  displayNames: ReadonlyMap<string, string>,
): ChannelReplyContext | undefined {
  if (!replyContext) return undefined;
  const userMentions = buildChannelUserMentions(
    replyContext.text,
    displayNames,
  );
  return userMentions ? { ...replyContext, userMentions } : replyContext;
}

function withResolvedEntryMentions(
  entry: ChannelThreadContextEntry,
  displayNames: ReadonlyMap<string, string>,
): ChannelThreadContextEntry {
  const userMentions = buildChannelUserMentions(entry.text, displayNames);
  return userMentions ? { ...entry, userMentions } : entry;
}

export async function resolveSlackUserMentionsInMessage(params: {
  message: InboundChannelMessage;
  resolveUserName: ResolveSlackUserName;
}): Promise<InboundChannelMessage> {
  const { message } = params;
  const userIds = collectMentionUserIds(message);
  if (userIds.length === 0) return message;

  const resolvedNames = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const name = await params.resolveUserName(userId);
        return [userId, sanitizeSlackUserDisplayName(name, userId)] as const;
      } catch {
        return [userId, userId] as const;
      }
    }),
  );
  const displayNames = new Map(resolvedNames);
  const userMentions = buildChannelUserMentions(message.text, displayNames);
  const replyContext = withResolvedReplyMentions(
    message.replyContext,
    displayNames,
  );
  const starter = message.threadContext?.starter
    ? withResolvedEntryMentions(message.threadContext.starter, displayNames)
    : undefined;
  const history = message.threadContext?.history?.map((entry) =>
    withResolvedEntryMentions(entry, displayNames),
  );

  return {
    ...message,
    ...(userMentions ? { userMentions } : {}),
    ...(replyContext ? { replyContext } : {}),
    ...(message.threadContext
      ? {
          threadContext: {
            ...message.threadContext,
            ...(starter ? { starter } : {}),
            ...(history ? { history } : {}),
          },
        }
      : {}),
  };
}
