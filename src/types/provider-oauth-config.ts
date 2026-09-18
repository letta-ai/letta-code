import { type ChatGPTOAuthConfig, isChatGPTOAuthConfig } from "./chatgpt-oauth";

/**
 * Subscription OAuth tokens for a local provider, in the shape pi-ai persists
 * (`OAuthCredential`). A client that ran the provider's own device-code login
 * (Desktop runs xAI's in the renderer) sends this with `connect_provider`.
 *
 * `refresh` is required: the local provider store refreshes through pi-ai once
 * `expires` passes, so an access-token-only bundle would connect and then stop
 * working within the hour.
 */
export interface ProviderOAuthTokensConfig {
  type: "oauth";
  access: string;
  refresh: string;
  /** Epoch milliseconds, matching pi-ai. */
  expires: number;
}

/** Credentials `connect_provider` accepts for an OAuth provider. */
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
    config.access.length > 0 &&
    typeof config.refresh === "string" &&
    config.refresh.length > 0 &&
    typeof config.expires === "number" &&
    Number.isFinite(config.expires)
  );
}

export function isConnectProviderOAuthConfig(
  value: unknown,
): value is ConnectProviderOAuthConfig {
  return isProviderOAuthTokensConfig(value) || isChatGPTOAuthConfig(value);
}
