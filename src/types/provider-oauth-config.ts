import { type ChatGPTOAuthConfig, isChatGPTOAuthConfig } from "./chatgpt-oauth";

export interface ProviderOAuthTokensConfig {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export type ConnectProviderOAuthConfig =
  | ChatGPTOAuthConfig
  | ProviderOAuthTokensConfig;

export function isProviderOAuthTokensConfig(
  value: unknown,
): value is ProviderOAuthTokensConfig {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<
    Record<keyof ProviderOAuthTokensConfig, unknown>
  >;
  return (
    config.type === "oauth" &&
    typeof config.access === "string" &&
    config.access.trim().length > 0 &&
    typeof config.refresh === "string" &&
    config.refresh.trim().length > 0 &&
    typeof config.expires === "number" &&
    Number.isFinite(config.expires)
  );
}

export function isConnectProviderOAuthConfig(
  value: unknown,
): value is ConnectProviderOAuthConfig {
  return isProviderOAuthTokensConfig(value) || isChatGPTOAuthConfig(value);
}
