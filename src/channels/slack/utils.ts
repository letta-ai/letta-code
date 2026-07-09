import type { ChannelTurnSource } from "@/channels/types";
import type {
  SlackAppConstructor,
  SlackBlock,
  SlackBoltModule,
} from "./internal-types";

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

export function resolveSlackAppConstructor(
  mod: SlackBoltModule,
): SlackAppConstructor {
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

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function resolveSlackSenderTeamId(value: unknown): string | undefined {
  const record = asRecord(value);
  return record
    ? firstNonEmptyString(record.user_team, record.team_id, record.team)
    : undefined;
}

export function normalizeSlackText(text: string): string {
  return text.replace(/^(?:\s*<@[A-Z0-9]+>\s*)+/, "").trim();
}

const IGNORED_SLACK_MESSAGE_SUBTYPES = new Set([
  "assistant_app_thread",
  "bot_message",
  "channel_archive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "channel_join",
  "channel_leave",
  "channel_name",
  "channel_posting_permissions",
  "channel_purpose",
  "channel_topic",
  "channel_unarchive",
  "document_mention",
  "ekm_access_denied",
  "file_comment",
  "group_archive",
  "group_join",
  "group_leave",
  "group_name",
  "group_purpose",
  "group_topic",
  "group_unarchive",
  "pinned_item",
  "reminder_add",
  "unpinned_item",
]);

const WRAPPER_SLACK_MESSAGE_SUBTYPES = new Set([
  "message_changed",
  "message_deleted",
  "message_replied",
]);

export type SlackProcessableInboundMessage = Record<string, unknown> & {
  user: string;
  ts: string;
};

export function isProcessableSlackInboundMessage(
  rawMessage: Record<string, unknown>,
): rawMessage is SlackProcessableInboundMessage {
  if (
    isNonEmptyString(rawMessage.bot_id) ||
    !isNonEmptyString(rawMessage.user) ||
    !isNonEmptyString(rawMessage.ts) ||
    rawMessage.hidden === true
  ) {
    return false;
  }
  const subtype = isNonEmptyString(rawMessage.subtype)
    ? rawMessage.subtype
    : null;
  if (!subtype) {
    return true;
  }
  if (IGNORED_SLACK_MESSAGE_SUBTYPES.has(subtype)) {
    return false;
  }
  return !(
    WRAPPER_SLACK_MESSAGE_SUBTYPES.has(subtype) &&
    asRecord(rawMessage.message) !== null
  );
}

export function slackTimestampToMillis(timestamp: string): number {
  return Math.round(Number.parseFloat(timestamp) * 1000);
}

export function resolveSlackChatType(chatId: string): "direct" | "channel" {
  return chatId.startsWith("D") ? "direct" : "channel";
}

export function resolveSlackOutboundThreadTs(params: {
  chatId: string;
  threadId?: string | null;
  replyToMessageId?: string | null;
}): string | undefined {
  if (resolveSlackChatType(params.chatId) === "direct") {
    return firstNonEmptyString(params.threadId);
  }
  return firstNonEmptyString(params.threadId, params.replyToMessageId);
}

export function asSlackBlocks(
  blocks: unknown[] | undefined,
): SlackBlock[] | undefined {
  return Array.isArray(blocks) ? (blocks as SlackBlock[]) : undefined;
}

export function getSlackActionRecord(
  action: unknown,
  body: unknown,
): Record<string, unknown> | null {
  const directAction = asRecord(action);
  if (directAction) {
    return directAction;
  }
  const actions = asRecord(body)?.actions;
  return Array.isArray(actions) ? asRecord(actions[0]) : null;
}

export function resolveSlackSelectedModel(
  action: unknown,
  body: unknown,
): string | null {
  const actionRecord = getSlackActionRecord(action, body);
  const selectedOption = asRecord(actionRecord?.selected_option);
  return (
    firstNonEmptyString(selectedOption?.value, actionRecord?.value) ?? null
  );
}

export function resolveSlackActionChannelId(body: unknown): string | null {
  const bodyRecord = asRecord(body);
  const channel = asRecord(bodyRecord?.channel);
  const container = asRecord(bodyRecord?.container);
  return firstNonEmptyString(channel?.id, container?.channel_id) ?? null;
}

export function resolveSlackActionThreadId(body: unknown): string | null {
  const bodyRecord = asRecord(body);
  const container = asRecord(bodyRecord?.container);
  const message = asRecord(bodyRecord?.message);
  return firstNonEmptyString(container?.thread_ts, message?.thread_ts) ?? null;
}

export function resolveSlackActionMessageId(body: unknown): string | undefined {
  const bodyRecord = asRecord(body);
  const container = asRecord(bodyRecord?.container);
  const message = asRecord(bodyRecord?.message);
  return firstNonEmptyString(container?.message_ts, message?.ts);
}

export function resolveSlackActionUser(body: unknown): {
  id: string | null;
  name?: string;
  teamId?: string;
} {
  const user = asRecord(asRecord(body)?.user);
  return {
    id: firstNonEmptyString(user?.id) ?? null,
    name: firstNonEmptyString(user?.name, user?.username, user?.id),
    teamId: firstNonEmptyString(user?.team_id),
  };
}

export function resolveSlackSourceThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    return firstNonEmptyString(source.threadId);
  }
  return firstNonEmptyString(source.threadId, source.messageId);
}

export function resolveSlackProgressThreadTs(
  source: ChannelTurnSource,
): string | undefined {
  if (
    source.chatType === "direct" ||
    resolveSlackChatType(source.chatId) === "direct"
  ) {
    return firstNonEmptyString(source.threadId, source.messageId);
  }
  return resolveSlackSourceThreadTs(source);
}

export function normalizeSlackReactionName(value: string): string {
  return value.trim().replace(/^:+|:+$/g, "");
}

export function resolveSlackUserDisplayName(
  userInfo: unknown,
): string | undefined {
  const user = asRecord(asRecord(userInfo)?.user);
  const profile = asRecord(user?.profile);
  return firstNonEmptyString(
    profile?.display_name,
    profile?.real_name,
    user?.name,
  );
}

export function hasSlackMention(text: string, userId: string | null): boolean {
  return (
    isNonEmptyString(text) &&
    isNonEmptyString(userId) &&
    (text.includes(`<@${userId}>`) || text.includes(`<@${userId}|`))
  );
}

export function isSlackFlatChannelThreadOpener(
  source: ChannelTurnSource,
): boolean {
  return (
    source.chatType === "channel" &&
    isNonEmptyString(source.messageId) &&
    (!isNonEmptyString(source.threadId) || source.threadId === source.messageId)
  );
}
