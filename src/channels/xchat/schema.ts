import type { ChannelConfigSchema } from "@/channels/plugin-types";

export const XCHAT_CONFIG_SCHEMA: ChannelConfigSchema = {
  version: 1,
  fields: [
    {
      key: "bot_token",
      label: "Bot token",
      description: "X Chat bot bearer token (xcbot_...).",
      type: "secret",
      required: true,
      scope: "account",
      restartRequired: true,
    },
    {
      key: "pin",
      label: "Encryption PIN",
      description: "PIN that unlocks the bot's Juicebox encryption keys.",
      type: "secret",
      required: true,
      scope: "account",
      restartRequired: true,
    },
    {
      key: "activity_token",
      label: "App Bearer token",
      description:
        "App-only Bearer token for Message request discovery through the X activity stream.",
      type: "secret",
      required: false,
      scope: "account",
      restartRequired: true,
    },
    {
      key: "peer_user_ids",
      label: "Peer user IDs",
      description:
        "Known X user IDs to poll when activity-stream delivery is unavailable.",
      type: "string-array",
      required: false,
      scope: "account",
      restartRequired: true,
    },
    {
      key: "poll_interval_ms",
      label: "Poll interval",
      description: "How often to check X Chat for new encrypted messages.",
      type: "number",
      default: 4_000,
      min: 1_000,
      max: 60_000,
      step: 1_000,
      suffix: "ms",
      scope: "account",
      restartRequired: true,
    },
    {
      key: "bootstrap_lookback_minutes",
      label: "Startup lookback",
      description:
        "Deliver recent messages on first start while suppressing older history.",
      type: "number",
      default: 10,
      min: 0,
      max: 2_880,
      step: 1,
      suffix: "minutes",
      scope: "account",
    },
  ],
};
