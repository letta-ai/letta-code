export type DmPolicy = "pairing" | "allowlist" | "open";
export type ChannelReplyMode = "tool" | "relay";
export type ChannelPluginConfig = Record<string, unknown>;

export interface ChannelAccountCreatePayload {
  account_id?: string;
  display_name?: string;
  enabled?: boolean;
  dm_policy?: DmPolicy;
  reply_mode?: ChannelReplyMode;
  allowed_users?: string[];
  /** Plugin-owned account config. New fields should be added here, not centrally. */
  config?: ChannelPluginConfig;
}
