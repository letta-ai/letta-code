/**
 * Channel config read/write helpers.
 *
 * Channel configs live at ~/.letta/channels/<channel_name>/config.yaml.
 * This module handles reading, writing, and validating channel configs.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ChannelConfig,
  DmPolicy,
  SlackChannelConfig,
  TelegramChannelConfig,
} from "./types";

// ── Paths ─────────────────────────────────────────────────────────

const CHANNELS_ROOT = join(homedir(), ".letta", "channels");

export function getChannelsRoot(): string {
  return CHANNELS_ROOT;
}

export function getChannelDir(channelId: string): string {
  return join(CHANNELS_ROOT, channelId);
}

export function getChannelConfigPath(channelId: string): string {
  return join(getChannelDir(channelId), "config.yaml");
}

export function getChannelAccountsPath(channelId: string): string {
  return join(getChannelDir(channelId), "accounts.json");
}

export function getChannelRoutingPath(channelId: string): string {
  return join(getChannelDir(channelId), "routing.yaml");
}

export function getChannelPairingPath(channelId: string): string {
  return join(getChannelDir(channelId), "pairing.yaml");
}

export function getChannelTargetsPath(channelId: string): string {
  return join(getChannelDir(channelId), "targets.json");
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
    };
  },
};

const CHANNEL_CONFIG_CODECS: Partial<
  Record<string, ChannelConfigCodec<ChannelConfig>>
> = {
  telegram: telegramConfigCodec as ChannelConfigCodec<ChannelConfig>,
  slack: slackConfigCodec as ChannelConfigCodec<ChannelConfig>,
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
