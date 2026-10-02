export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

export function hasValidChannelPolicyFields(
  config: Record<string, unknown>,
): boolean {
  const hasValidDmPolicy =
    config.dm_policy === undefined ||
    config.dm_policy === "pairing" ||
    config.dm_policy === "allowlist" ||
    config.dm_policy === "open";
  const hasValidReplyMode =
    config.reply_mode === undefined ||
    config.reply_mode === "tool" ||
    config.reply_mode === "relay";
  const hasValidAllowedUsers =
    config.allowed_users === undefined ||
    (Array.isArray(config.allowed_users) &&
      config.allowed_users.every((entry) => typeof entry === "string"));
  const hasValidDisplayName =
    config.display_name === undefined ||
    typeof config.display_name === "string";
  const hasValidEnabled =
    config.enabled === undefined || typeof config.enabled === "boolean";
  return (
    hasValidDmPolicy &&
    hasValidReplyMode &&
    hasValidAllowedUsers &&
    hasValidDisplayName &&
    hasValidEnabled
  );
}

export function hasOnlyFields(
  value: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
): boolean {
  return Object.keys(value).every((field) => allowedFields.has(field));
}

export const CHANNEL_ACCOUNT_CREATE_FIELDS = new Set([
  "account_id",
  "display_name",
  "enabled",
  "dm_policy",
  "reply_mode",
  "allowed_users",
  "config",
]);

export const CHANNEL_ACCOUNT_UPDATE_FIELDS = new Set([
  "display_name",
  "enabled",
  "dm_policy",
  "reply_mode",
  "allowed_users",
  "config",
]);

export const CHANNEL_SET_CONFIG_FIELDS = new Set([
  "dm_policy",
  "reply_mode",
  "allowed_users",
  "plugin_config",
]);
