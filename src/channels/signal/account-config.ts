import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type { SignalChannelAccount, SignalGroupMode } from "@/channels/types";

const SIGNAL_CONFIG_KEYS = new Set([
  "base_url",
  "account",
  "account_uuid",
  "agent_id",
  "self_chat_mode",
  "group_mode",
  "allowed_groups",
  "mention_patterns",
  "recipient_aliases",
  "transcribe_voice",
  "download_media",
  "media_max_bytes",
]);

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function isGroupMode(value: unknown): value is SignalGroupMode {
  return value === "disabled" || value === "mention" || value === "open";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function normalizeOptionalString(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export const signalAccountConfigAdapter: ChannelAccountConfigAdapter<SignalChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!SIGNAL_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.base_url === undefined || isNullableString(config.base_url)) &&
        (config.account === undefined || isNullableString(config.account)) &&
        (config.account_uuid === undefined ||
          isNullableString(config.account_uuid)) &&
        (config.agent_id === undefined || isNullableString(config.agent_id)) &&
        (config.self_chat_mode === undefined ||
          isBoolean(config.self_chat_mode)) &&
        (config.group_mode === undefined || isGroupMode(config.group_mode)) &&
        (config.allowed_groups === undefined ||
          isStringArray(config.allowed_groups)) &&
        (config.mention_patterns === undefined ||
          isStringArray(config.mention_patterns)) &&
        (config.recipient_aliases === undefined ||
          isStringRecord(config.recipient_aliases)) &&
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.download_media === undefined ||
          isBoolean(config.download_media)) &&
        (config.media_max_bytes === undefined ||
          isPositiveNumber(config.media_max_bytes))
      );
    },

    toAccountPatch(config) {
      return {
        baseUrl: isNullableString(config.base_url)
          ? (config.base_url ?? "")
          : undefined,
        account: isNullableString(config.account)
          ? (normalizeOptionalString(config.account) ?? "")
          : undefined,
        accountUuid: isNullableString(config.account_uuid)
          ? (normalizeOptionalString(config.account_uuid) ?? "")
          : undefined,
        agentId: isNullableString(config.agent_id)
          ? config.agent_id
          : undefined,
        selfChatMode: isBoolean(config.self_chat_mode)
          ? config.self_chat_mode
          : undefined,
        groupMode: isGroupMode(config.group_mode)
          ? config.group_mode
          : undefined,
        allowedGroups: isStringArray(config.allowed_groups)
          ? [...config.allowed_groups]
          : undefined,
        mentionPatterns: isStringArray(config.mention_patterns)
          ? [...config.mention_patterns]
          : undefined,
        recipientAliases: isStringRecord(config.recipient_aliases)
          ? { ...config.recipient_aliases }
          : undefined,
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        downloadMedia: isBoolean(config.download_media)
          ? config.download_media
          : undefined,
        mediaMaxBytes: isPositiveNumber(config.media_max_bytes)
          ? config.media_max_bytes
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        base_url: account.baseUrl,
        account: account.account,
        account_uuid: account.accountUuid,
        agent_id: account.agentId,
        self_chat_mode: account.selfChatMode,
        group_mode: account.groupMode,
        allowed_groups: [...(account.allowedGroups ?? [])],
        mention_patterns: [...(account.mentionPatterns ?? [])],
        recipient_aliases: { ...(account.recipientAliases ?? {}) },
        transcribe_voice: account.transcribeVoice === true,
        download_media: account.downloadMedia === true,
        media_max_bytes: account.mediaMaxBytes,
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        base_url: account.baseUrl,
        account: account.account,
        account_uuid: account.accountUuid,
        agent_id: account.agentId,
        self_chat_mode: account.selfChatMode,
        group_mode: account.groupMode,
        allowed_groups: [...(account.allowedGroups ?? [])],
        mention_patterns: [...(account.mentionPatterns ?? [])],
        recipient_aliases: { ...(account.recipientAliases ?? {}) },
        transcribe_voice: account.transcribeVoice === true,
        download_media: account.downloadMedia === true,
        media_max_bytes: account.mediaMaxBytes,
      };
    },

    shouldRefreshDisplayName(patch) {
      return patch.baseUrl !== undefined || patch.account !== undefined;
    },
  };
