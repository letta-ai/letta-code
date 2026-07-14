import { migratePermissionMode } from "@/permissions/mode";
import { isRecord } from "@/utils/type-guards";
import { normalizeSlackAllowBotsMode } from "./slack/bot-policy";
import type {
  ChannelAccount,
  ChannelDefaultPermissionMode,
  CustomChannelAccount,
  DiscordChannelAccount,
  SignalChannelAccount,
  SlackChannelAccount,
  TelegramChannelAccount,
  WhatsAppChannelAccount,
} from "./types";
import {
  DEFAULT_SLACK_PERMISSION_MODE,
  isCustomChannelAccount,
  isDiscordChannelAccount,
  isFirstPartyChannelId,
  isSignalChannelAccount,
  isSlackChannelAccount,
  isTelegramChannelAccount,
  isWhatsAppChannelAccount,
} from "./types";

/**
 * Known snake_case → camelCase key mappings for migration.
 * When both forms exist on a loaded account, snake_case wins and a
 * warning is logged. Only the camelCase form is kept in the runtime
 * account object; the canonicalized snake_case form is emitted on save.
 */
export const SNAKE_TO_CAMEL: Record<string, string> = {
  account_uuid: "accountUuid",
  allowed_channels: "allowedChannels",
  allowed_groups: "allowedGroups",
  allow_bots: "allowBots",
  auto_thread_on_mention: "autoThreadOnMention",
  base_url: "baseUrl",
  acknowledge_message_reaction: "acknowledgeMessageReaction",
  group_mode: "groupMode",
  inbound_debounce_ms: "inboundDebounceMs",
  listen_mode: "listenMode",
  media_max_bytes: "mediaMaxBytes",
  mention_patterns: "mentionPatterns",
  recipient_aliases: "recipientAliases",
  remove_stale_routes: "removeStaleRoutes",
  rich_draft_streaming: "richDraftStreaming",
  rich_private_chat_default: "richPrivateChatDefault",
  thread_policy_by_channel: "threadPolicyByChannel",
  transcribe_voice: "transcribeVoice",
  download_media: "downloadMedia",
};

let warnedAboutDualKeys = false;

export function resetAccountNormalizationWarnings(): void {
  warnedAboutDualKeys = false;
}

export function cloneAccount<T extends ChannelAccount>(account: T): T {
  const cloned = {
    ...account,
    allowedUsers: [...account.allowedUsers],
  } as T;

  if (isTelegramChannelAccount(account)) {
    (cloned as TelegramChannelAccount).binding = { ...account.binding };
  }

  if (isDiscordChannelAccount(account) && account.allowedChannels) {
    (cloned as DiscordChannelAccount).allowedChannels = Array.isArray(
      account.allowedChannels,
    )
      ? [...account.allowedChannels]
      : { ...account.allowedChannels };
  }

  if (isWhatsAppChannelAccount(account)) {
    (cloned as WhatsAppChannelAccount).allowedGroups = [
      ...(account.allowedGroups ?? []),
    ];
    (cloned as WhatsAppChannelAccount).mentionPatterns = [
      ...(account.mentionPatterns ?? []),
    ];
  }

  if (isSignalChannelAccount(account)) {
    (cloned as SignalChannelAccount).allowedGroups = [
      ...(account.allowedGroups ?? []),
    ];
    (cloned as SignalChannelAccount).mentionPatterns = [
      ...(account.mentionPatterns ?? []),
    ];
    (cloned as SignalChannelAccount).recipientAliases = {
      ...(account.recipientAliases ?? {}),
    };
  }

  if ("config" in account) {
    (cloned as CustomChannelAccount).config = { ...account.config };
  }

  return cloned;
}

export function normalizeLoadedAccount<T extends ChannelAccount>(
  account: T,
): T {
  const next = cloneAccount(account);

  // ── Key migration: accept snake_case keys from accounts.json ──
  // Runtime code uses camelCase throughout. On read, accept both forms;
  // if both exist, snake_case wins (log warning once).
  const raw = account as unknown as Record<string, unknown>;
  for (const [snakeKey, camelKey] of Object.entries(SNAKE_TO_CAMEL)) {
    const hasSnake = snakeKey in raw;
    const hasCamel = camelKey in raw;
    if (hasSnake && hasCamel) {
      if (!warnedAboutDualKeys) {
        warnedAboutDualKeys = true;
        console.warn(
          `[accounts] Both "${snakeKey}" and "${camelKey}" found in loaded account. "${snakeKey}" takes precedence. Remove "${camelKey}" to silence this warning.`,
        );
      }
      (next as unknown as Record<string, unknown>)[camelKey] = (
        next as unknown as Record<string, unknown>
      )[snakeKey];
      continue;
    }
    if (hasSnake && !hasCamel) {
      (next as unknown as Record<string, unknown>)[camelKey] = raw[snakeKey];
    }
    // hasCamel && !hasSnake → already on the object, nothing to do
  }

  // Both the "custom" first-party channel and all user-installed channels use
  // the generic `config: Record<string, unknown>` shape, so make sure that
  // field is present and well-formed before downstream code reads it.
  if (isCustomChannelAccount(next) || !isFirstPartyChannelId(next.channel)) {
    (next as CustomChannelAccount).config = isRecord(
      (next as Partial<CustomChannelAccount>).config,
    )
      ? { ...(next as CustomChannelAccount).config }
      : {};
  }
  if (
    (isTelegramChannelAccount(next) &&
      (next.displayName === "Telegram bot" ||
        next.displayName === "Migrated Telegram bot")) ||
    (isSlackChannelAccount(next) &&
      (next.displayName === "Slack app" ||
        next.displayName === "Migrated Slack app")) ||
    (isDiscordChannelAccount(next) &&
      (next.displayName === "Discord bot" ||
        next.displayName === "Migrated Discord bot")) ||
    (isWhatsAppChannelAccount(next) && next.displayName === "WhatsApp") ||
    (isSignalChannelAccount(next) && next.displayName === "Signal")
  ) {
    next.displayName = undefined;
  }
  if (isSlackChannelAccount(next)) {
    const migrated = migratePermissionMode(
      (next as SlackChannelAccount).defaultPermissionMode ??
        DEFAULT_SLACK_PERMISSION_MODE,
    );
    (next as SlackChannelAccount).defaultPermissionMode =
      (migrated as ChannelDefaultPermissionMode | null) ??
      DEFAULT_SLACK_PERMISSION_MODE;
    (next as SlackChannelAccount).transcribeVoice =
      (next as SlackChannelAccount).transcribeVoice === true;
    delete (next as unknown as Record<string, unknown>).show_completed_reaction;
    delete (next as unknown as Record<string, unknown>).showCompletedReaction;
    delete (next as unknown as Record<string, unknown>).progress_ui;
    delete (next as unknown as Record<string, unknown>).progressUi;
    (next as SlackChannelAccount).listenMode =
      (next as SlackChannelAccount).listenMode === true;
    (next as SlackChannelAccount).allowBots = normalizeSlackAllowBotsMode(
      (next as SlackChannelAccount).allowBots,
    );
  }
  if (isDiscordChannelAccount(next)) {
    const migrated = migratePermissionMode(
      (next as DiscordChannelAccount).defaultPermissionMode ?? "standard",
    );
    (next as DiscordChannelAccount).defaultPermissionMode =
      (migrated as ChannelDefaultPermissionMode | null) ?? "standard";

    // Compatibility migration: existing accounts created before this field was
    // persisted auto-threaded on mentions by default. Keep that behavior for
    // accounts that lack an explicit setting, while new accounts write false.
    if (!("auto_thread_on_mention" in raw) && !("autoThreadOnMention" in raw)) {
      (next as DiscordChannelAccount).autoThreadOnMention = true;
    }
  }
  if (isWhatsAppChannelAccount(next)) {
    next.selfChatMode = next.selfChatMode !== false;
    next.groupMode = next.groupMode ?? "disabled";
    next.allowedGroups = [...(next.allowedGroups ?? [])];
    next.mentionPatterns = [...(next.mentionPatterns ?? [])];
    next.downloadMedia = next.downloadMedia === true;
    next.transcribeVoice = next.transcribeVoice === true;
  }
  if (isSignalChannelAccount(next)) {
    next.baseUrl = next.baseUrl ?? "";
    next.selfChatMode = next.selfChatMode === true;
    next.groupMode = next.groupMode ?? "disabled";
    next.allowedGroups = [...(next.allowedGroups ?? [])];
    next.mentionPatterns = [...(next.mentionPatterns ?? [])];
    next.recipientAliases = { ...(next.recipientAliases ?? {}) };
    next.downloadMedia = next.downloadMedia !== false;
  }
  if (isTelegramChannelAccount(next)) {
    next.richPrivateChatDefault = next.richPrivateChatDefault !== false;
  }
  return next;
}
