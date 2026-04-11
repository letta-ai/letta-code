/**
 * Channel config read/write helpers.
 *
 * Channel configs live at ~/.letta/channels/<channel_name>/config.yaml.
 * This module handles reading, writing, and validating channel configs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
 * Minimal YAML serializer for flat/shallow objects.
 * Avoids pulling in a full YAML library for simple config files.
 */
function toSimpleYaml(obj: Record<string, unknown>, indent = 0): string {
  const prefix = " ".repeat(indent);
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${prefix}${key}: []`);
      } else if (
        typeof value[0] === "object" &&
        value[0] !== null &&
        !Array.isArray(value[0])
      ) {
        lines.push(`${prefix}${key}:`);
        for (const item of value) {
          const itemLines = toSimpleYaml(
            item as Record<string, unknown>,
            indent + 4,
          ).split("\n");
          if (itemLines.length > 0 && itemLines[0]) {
            lines.push(`${prefix}  - ${itemLines[0].trimStart()}`);
            for (let i = 1; i < itemLines.length; i++) {
              if (itemLines[i]) {
                lines.push(`${prefix}    ${itemLines[i]?.trimStart()}`);
              }
            }
          }
        }
      } else {
        lines.push(`${prefix}${key}:`);
        for (const item of value) {
          lines.push(`${prefix}  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof value === "object" && value !== null) {
      lines.push(`${prefix}${key}:`);
      lines.push(toSimpleYaml(value as Record<string, unknown>, indent + 2));
    } else if (typeof value === "string") {
      lines.push(`${prefix}${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${prefix}${key}: ${String(value)}`);
    }
  }

  return lines.join("\n");
}

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
  serialize(config: TConfig): Record<string, unknown>;
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
  serialize(config) {
    return {
      channel: config.channel,
      enabled: config.enabled,
      token: config.token,
      dm_policy: config.dmPolicy,
      allowed_users: config.allowedUsers,
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
  serialize(config) {
    return {
      channel: config.channel,
      enabled: config.enabled,
      mode: config.mode,
      bot_token: config.botToken,
      app_token: config.appToken,
      dm_policy: config.dmPolicy,
      allowed_users: config.allowedUsers,
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

export function channelConfigExists(channelId: string): boolean {
  return existsSync(getChannelConfigPath(channelId));
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

export function writeChannelConfig(
  channelId: string,
  config: ChannelConfig,
): void {
  const dir = getChannelDir(channelId);
  mkdirSync(dir, { recursive: true });
  const codec = getChannelConfigCodec(channelId);
  if (!codec) {
    throw new Error(`Unsupported channel config: ${channelId}`);
  }

  const text = toSimpleYaml(codec.serialize(config));
  writeFileSync(getChannelConfigPath(channelId), `${text}\n`, "utf-8");
}
