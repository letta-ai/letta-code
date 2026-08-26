export interface ChatGPTOAuthConfig {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  account_id: string;
  expires_at: number;
}

export function isChatGPTOAuthConfig(
  value: unknown,
): value is ChatGPTOAuthConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<Record<keyof ChatGPTOAuthConfig, unknown>>;
  return (
    typeof config.access_token === "string" &&
    config.access_token.length > 0 &&
    typeof config.id_token === "string" &&
    config.id_token.length > 0 &&
    (config.refresh_token === undefined ||
      typeof config.refresh_token === "string") &&
    typeof config.account_id === "string" &&
    config.account_id.length > 0 &&
    typeof config.expires_at === "number" &&
    Number.isFinite(config.expires_at)
  );
}
