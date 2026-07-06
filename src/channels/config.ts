/**
 * Channel config read/write helpers.
 *
 * Channel configs live at ~/.letta/channels/<channel_name>/config.yaml.
 * This module handles reading, writing, and validating channel configs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { migratePermissionMode } from "@/permissions/mode";
import type {
  ChannelConfig,
  ChannelDefaultPermissionMode,
  DiscordChannelConfig,
  DiscordChannelMode,
  DmPolicy,
  SignalChannelConfig,
  SignalGroupMode,
  SlackChannelConfig,
  TelegramChannelConfig,
  TelegramGroupMode,
  WhatsAppChannelConfig,
  WhatsAppGroupMode,
} from "./types";

// ── Paths ─────────────────────────────────────────────────────────

const CHANNELS_ROOT = join(homedir(), ".letta", "channels");
let channelsRootOverride: string | null = null;

export function getChannelsRoot(): string {
  return channelsRootOverride ?? CHANNELS_ROOT;
}

export function getChannelDir(channelId: string): string {
  return join(getChannelsRoot(), channelId);
}

export function getChannelConfigPath(channelId: string): string {
  return join(getChannelDir(channelId), "config.yaml");
}

export function getChannelAccountsPath(channelId: string): string {
  return join(getChannelDir(channelId), "accounts.json");
}

export function getChannelRoutingPath(channelId: string): string {
  return join(getChannelDir(channelId), "routing.json");
}

/**
 * Legacy routing path from the original channels MVP, when the file was named
 * `routing.yaml` despite holding JSON content. Used only for one-time migration
 * to the correctly-named `routing.json`. See issue #3076.
 */
export function getLegacyChannelRoutingPath(channelId: string): string {
  return join(getChannelDir(channelId), "routing.yaml");
}

export function getChannelPairingPath(channelId: string): string {
  return join(getChannelDir(channelId), "pairing.yaml");
}

export function getChannelTargetsPath(channelId: string): string {
  return join(getChannelDir(channelId), "targets.json");
}

export function getPendingChannelControlRequestsPath(): string {
  return join(getChannelsRoot(), "pending-control-requests.json");
}

export function __testOverrideChannelsRoot(root: string | null): void {
  channelsRootOverride = root;
}

// ── YAML helpers ──────────────────────────────────────────────────

/**
 * Minimal YAML parser for simple key-value configs.
 * Handles: strings, booleans, numbers, simple arrays.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let currentKey: string | null = null;
  let currentArray: unknown[] | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith("#")) continue;

    // Array item
    const arrayMatch = line.match(/^\s+-\s+(.*)/);
    if (arrayMatch && currentKey && currentArray) {
      const val = parseYamlValue(arrayMatch[1]?.trim() ?? "");
      currentArray.push(val);
      continue;
    }

    // Key-value pair
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)/);
    if (kvMatch) {
      // Save previous array if any
      if (currentKey && currentArray) {
        result[currentKey] = currentArray;
        currentArray = null;
      }

      const key = kvMatch[1] as string;
      const rawValue = (kvMatch[2] ?? "").trim();

      if (rawValue === "" || rawValue === "[]") {
        currentKey = key;
        currentArray = rawValue === "[]" ? [] : [];
        result[key] = currentArray;
      } else {
        currentKey = null;
        currentArray = null;
        result[key] = parseYamlValue(rawValue);
      }
    }
  }

  // Save trailing array
  if (currentKey && currentArray) {
    result[currentKey] = currentArray;
  }

  return result;
}

function parseYamlValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  // Strip quotes
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return raw.slice(1, -1);
  }
  return raw;
}

// ── Config read/write ─────────────────────────────────────────────

interface ChannelConfigCodec<TConfig extends ChannelConfig> {
  parse(parsed: Record<string, unknown>): TConfig;
}

const telegramConfigCodec: ChannelConfigCodec<TelegramChannelConfig> = {
  parse(parsed) {
    return {
      channel: "telegram",
      enabled: parsed.enabled !== false,
      token: String(parsed.token ?? ""),
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      groupMode: parseTelegramGroupMode(parsed.group_mode),
      transcribeVoice: parsed.transcribe_voice === true,
      richPrivateChatDefault: parsed.rich_private_chat_default !== false,
      richDraftStreaming: parsed.rich_draft_streaming === true,
    };
  },
};

const slackConfigCodec: ChannelConfigCodec<SlackChannelConfig> = {
  parse(parsed) {
    return {
      channel: "slack",
      enabled: parsed.enabled !== false,
      mode: "socket",
      botToken: String(parsed.bot_token ?? ""),
      appToken: String(parsed.app_token ?? ""),
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      transcribeVoice: parsed.transcribe_voice === true,
      showCompletedReaction: parsed.show_completed_reaction !== false,
      listenMode: parsed.listen_mode === true,
    };
  },
};

function parseDefaultPermissionMode(
  value: unknown,
): ChannelDefaultPermissionMode {
  if (typeof value !== "string") return "standard";
  const migrated = migratePermissionMode(value);
  return migrated === "standard" ||
    migrated === "acceptEdits" ||
    migrated === "unrestricted"
    ? migrated
    : "standard";
}

function parseTelegramGroupMode(value: unknown): TelegramGroupMode {
  return value === "mention-only" ? "mention-only" : "open";
}

function parseSignalGroupMode(value: unknown): SignalGroupMode {
  return value === "open" || value === "mention" ? value : "disabled";
}

const discordConfigCodec: ChannelConfigCodec<DiscordChannelConfig> = {
  parse(parsed) {
    const rawAllowedChannels = parsed.allowed_channels;
    let allowedChannels: DiscordChannelConfig["allowedChannels"];
    if (Array.isArray(rawAllowedChannels)) {
      allowedChannels = rawAllowedChannels as string[];
    } else if (
      rawAllowedChannels &&
      typeof rawAllowedChannels === "object" &&
      !Array.isArray(rawAllowedChannels)
    ) {
      allowedChannels = rawAllowedChannels as Record<
        string,
        DiscordChannelMode
      >;
    }
    return {
      channel: "discord",
      enabled: parsed.enabled !== false,
      token: String(parsed.token ?? ""),
      defaultPermissionMode: parseDefaultPermissionMode(
        parsed.default_permission_mode,
      ),
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      allowedChannels,
      transcribeVoice: parsed.transcribe_voice === true,
      autoThreadOnMention:
        typeof parsed.auto_thread_on_mention === "boolean"
          ? parsed.auto_thread_on_mention
          : undefined,
      threadPolicyByChannel:
        typeof parsed.thread_policy_by_channel === "object" &&
        !Array.isArray(parsed.thread_policy_by_channel)
          ? (parsed.thread_policy_by_channel as Record<string, boolean>)
          : undefined,
      acknowledgeMessageReaction:
        typeof parsed.acknowledge_message_reaction === "boolean"
          ? parsed.acknowledge_message_reaction
          : undefined,
      removeStaleRoutes:
        typeof parsed.remove_stale_routes === "boolean"
          ? parsed.remove_stale_routes
          : undefined,
      inboundDebounceMs:
        typeof parsed.inbound_debounce_ms === "number" &&
        Number.isFinite(parsed.inbound_debounce_ms) &&
        parsed.inbound_debounce_ms >= 0
          ? Math.trunc(Math.min(parsed.inbound_debounce_ms, 10000))
          : undefined,
    };
  },
};

const whatsappConfigCodec: ChannelConfigCodec<WhatsAppChannelConfig> = {
  parse(parsed) {
    const rawAllowedGroups = parsed.allowed_groups;
    const rawMentionPatterns = parsed.mention_patterns;
    return {
      channel: "whatsapp",
      enabled: parsed.enabled !== false,
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : null,
      selfChatMode: parsed.self_chat_mode !== false,
      groupMode: (parsed.group_mode as WhatsAppGroupMode) ?? "disabled",
      allowedGroups: Array.isArray(rawAllowedGroups)
        ? (rawAllowedGroups as string[])
        : undefined,
      mentionPatterns: Array.isArray(rawMentionPatterns)
        ? (rawMentionPatterns as string[])
        : undefined,
      transcribeVoice: parsed.transcribe_voice === true,
      downloadMedia: parsed.download_media === true,
      mediaMaxBytes:
        typeof parsed.media_max_bytes === "number"
          ? parsed.media_max_bytes
          : undefined,
    };
  },
};

const signalConfigCodec: ChannelConfigCodec<SignalChannelConfig> = {
  parse(parsed) {
    const rawAllowedGroups = parsed.allowed_groups;
    const rawMentionPatterns = parsed.mention_patterns;
    return {
      channel: "signal",
      enabled: parsed.enabled !== false,
      dmPolicy: (parsed.dm_policy as DmPolicy) ?? "pairing",
      allowedUsers: (parsed.allowed_users as string[]) ?? [],
      baseUrl:
        typeof parsed.base_url === "string"
          ? parsed.base_url
          : "http://127.0.0.1:8080",
      account: typeof parsed.account === "string" ? parsed.account : undefined,
      accountUuid:
        typeof parsed.account_uuid === "string"
          ? parsed.account_uuid
          : undefined,
      agentId: typeof parsed.agent_id === "string" ? parsed.agent_id : null,
      selfChatMode: parsed.self_chat_mode === true,
      groupMode: parseSignalGroupMode(parsed.group_mode),
      allowedGroups: Array.isArray(rawAllowedGroups)
        ? (rawAllowedGroups as string[])
        : undefined,
      mentionPatterns: Array.isArray(rawMentionPatterns)
        ? (rawMentionPatterns as string[])
        : undefined,
      transcribeVoice: parsed.transcribe_voice === true,
      downloadMedia: parsed.download_media !== false,
      mediaMaxBytes:
        typeof parsed.media_max_bytes === "number"
          ? parsed.media_max_bytes
          : undefined,
    };
  },
};

const CHANNEL_CONFIG_CODECS: Partial<
  Record<string, ChannelConfigCodec<ChannelConfig>>
> = {
  telegram: telegramConfigCodec as ChannelConfigCodec<ChannelConfig>,
  slack: slackConfigCodec as ChannelConfigCodec<ChannelConfig>,
  discord: discordConfigCodec as ChannelConfigCodec<ChannelConfig>,
  whatsapp: whatsappConfigCodec as ChannelConfigCodec<ChannelConfig>,
  signal: signalConfigCodec as ChannelConfigCodec<ChannelConfig>,
};

function getChannelConfigCodec(
  channelId: string,
): ChannelConfigCodec<ChannelConfig> | null {
  return CHANNEL_CONFIG_CODECS[channelId] ?? null;
}

export function readChannelConfig(channelId: string): ChannelConfig | null {
  const configPath = getChannelConfigPath(channelId);
  if (!existsSync(configPath)) return null;

  try {
    const text = readFileSync(configPath, "utf-8");
    const parsed = parseSimpleYaml(text);
    const codec = getChannelConfigCodec(channelId);
    if (!codec) return null;
    return codec.parse(parsed);
  } catch {
    return null;
  }
}
