import type { ChannelAccountConfigAdapter } from "@/channels/plugin-types";
import type {
  WhatsAppChannelAccount,
  WhatsAppGroupMode,
} from "@/channels/types";
import { toWhatsAppConnectionConfig } from "./state";

const WHATSAPP_CONFIG_KEYS = new Set([
  "agent_id",
  "self_chat_mode",
  "group_mode",
  "allowed_groups",
  "mention_patterns",
  "transcribe_voice",
  "download_media",
  "media_max_bytes",
  "message_prefix",
  "audio_as_voice_memo",
]);

function isString(value: unknown): value is string {
  return typeof value === "string";
}

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

function isGroupMode(value: unknown): value is WhatsAppGroupMode {
  return value === "disabled" || value === "mention" || value === "open";
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export const whatsappAccountConfigAdapter: ChannelAccountConfigAdapter<WhatsAppChannelAccount> =
  {
    isValidConfig(config) {
      for (const key of Object.keys(config)) {
        if (!WHATSAPP_CONFIG_KEYS.has(key)) {
          return false;
        }
      }
      return (
        (config.agent_id === undefined || isNullableString(config.agent_id)) &&
        (config.self_chat_mode === undefined ||
          isBoolean(config.self_chat_mode)) &&
        (config.group_mode === undefined || isGroupMode(config.group_mode)) &&
        (config.allowed_groups === undefined ||
          isStringArray(config.allowed_groups)) &&
        (config.mention_patterns === undefined ||
          isStringArray(config.mention_patterns)) &&
        (config.transcribe_voice === undefined ||
          isBoolean(config.transcribe_voice)) &&
        (config.download_media === undefined ||
          isBoolean(config.download_media)) &&
        (config.media_max_bytes === undefined ||
          isPositiveNumber(config.media_max_bytes)) &&
        (config.message_prefix === undefined ||
          isString(config.message_prefix)) &&
        (config.audio_as_voice_memo === undefined ||
          isBoolean(config.audio_as_voice_memo))
      );
    },

    toAccountPatch(config) {
      return {
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
        transcribeVoice: isBoolean(config.transcribe_voice)
          ? config.transcribe_voice
          : undefined,
        downloadMedia: isBoolean(config.download_media)
          ? config.download_media
          : undefined,
        mediaMaxBytes: isPositiveNumber(config.media_max_bytes)
          ? config.media_max_bytes
          : undefined,
        messagePrefix: isString(config.message_prefix)
          ? config.message_prefix
          : undefined,
        audioAsVoiceMemo: isBoolean(config.audio_as_voice_memo)
          ? config.audio_as_voice_memo
          : undefined,
      };
    },

    toAccountConfig(account) {
      return {
        agent_id: account.agentId,
        self_chat_mode: account.selfChatMode,
        group_mode: account.groupMode,
        allowed_groups: [...(account.allowedGroups ?? [])],
        mention_patterns: [...(account.mentionPatterns ?? [])],
        transcribe_voice: account.transcribeVoice === true,
        download_media: account.downloadMedia === true,
        media_max_bytes: account.mediaMaxBytes,
        message_prefix: account.messagePrefix,
        audio_as_voice_memo: account.audioAsVoiceMemo === true,
        ...toWhatsAppConnectionConfig(account.accountId),
      };
    },

    toConfigSnapshotConfig(account) {
      return {
        agent_id: account.agentId,
        self_chat_mode: account.selfChatMode,
        group_mode: account.groupMode,
        allowed_groups: [...(account.allowedGroups ?? [])],
        mention_patterns: [...(account.mentionPatterns ?? [])],
        transcribe_voice: account.transcribeVoice === true,
        download_media: account.downloadMedia === true,
        media_max_bytes: account.mediaMaxBytes,
        message_prefix: account.messagePrefix,
        audio_as_voice_memo: account.audioAsVoiceMemo === true,
        ...toWhatsAppConnectionConfig(account.accountId),
      };
    },

    shouldRefreshDisplayName() {
      return false;
    },
  };
