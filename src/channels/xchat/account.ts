import type { CustomChannelAccount } from "@/channels/types";
import { isRecord } from "@/utils/type-guards";

export const DEFAULT_XCHAT_POLL_INTERVAL_MS = 8_000;
export const DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES = 10;
export const DEFAULT_XCHAT_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

export interface XChatAccountSettings {
  botToken: string;
  pin: string;
  activityToken: string;
  peerUserIds: string[];
  pollIntervalMs: number;
  bootstrapLookbackMinutes: number;
  downloadMedia: boolean;
  mediaMaxBytes: number;
  transcribeVoice: boolean;
}

function readString(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(
  config: Record<string, unknown>,
  key: string,
): string[] {
  const value = config[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function readBoundedNumber(params: {
  config: Record<string, unknown>;
  key: string;
  fallback: number;
  min: number;
  max: number;
}): number {
  const raw = params.config[params.key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return params.fallback;
  return Math.trunc(Math.min(params.max, Math.max(params.min, value)));
}

export function readXChatAccountSettings(
  account: CustomChannelAccount,
): XChatAccountSettings {
  const config = isRecord(account.config) ? account.config : {};
  return {
    botToken: readString(config, "bot_token"),
    pin: readString(config, "pin"),
    activityToken: readString(config, "activity_token"),
    peerUserIds: readStringArray(config, "peer_user_ids"),
    pollIntervalMs: readBoundedNumber({
      config,
      key: "poll_interval_ms",
      fallback: DEFAULT_XCHAT_POLL_INTERVAL_MS,
      min: 1_000,
      max: 60_000,
    }),
    bootstrapLookbackMinutes: readBoundedNumber({
      config,
      key: "bootstrap_lookback_minutes",
      fallback: DEFAULT_XCHAT_BOOTSTRAP_LOOKBACK_MINUTES,
      min: 0,
      max: 2_880,
    }),
    downloadMedia: config.download_media !== false,
    mediaMaxBytes: readBoundedNumber({
      config,
      key: "media_max_bytes",
      fallback: DEFAULT_XCHAT_MEDIA_MAX_BYTES,
      min: 1_024,
      max: 50 * 1024 * 1024,
    }),
    transcribeVoice: config.transcribe_voice === true,
  };
}

export function assertXChatAccountConfigured(
  settings: XChatAccountSettings,
): void {
  if (!settings.botToken) {
    throw new Error("X Chat bot token is missing.");
  }
  if (!settings.pin) {
    throw new Error(
      "X Chat PIN is missing. The PIN unlocks the bot's registered encryption keys.",
    );
  }
}
