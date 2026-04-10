/**
 * OAuth 2.0 utilities for Letta Cloud authentication
 * Uses Device Code Flow for CLI authentication
 */

import Letta from "@letta-ai/letta-client";
import { trackBoundaryError } from "../telemetry/errorReporting";

export const LETTA_CLOUD_API_URL = "https://api.letta.com";

export const OAUTH_CONFIG = {
  clientId: "ci-let-724dea7e98f4af6f8f370f4b1466200c",
  clientSecret: "", // Not needed for device code flow
  authBaseUrl: "https://app.letta.com",
  apiBaseUrl: LETTA_CLOUD_API_URL,
} as const;

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

function getOAuthAuthHost(): string {
  try {
    return new URL(OAUTH_CONFIG.authBaseUrl).host;
  } catch {
    return OAUTH_CONFIG.authBaseUrl;
  }
}

function getErrorLikeMessage(value: unknown): string | null {
  if (value instanceof Error) {
    return value.message.trim() || null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const message = (value as { message?: unknown }).message;
  return typeof message === "string" && message.trim().length > 0
    ? message.trim()
    : null;
}

function getErrorLikeCode(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0
    ? code.trim()
    : null;
}

function isGenericFetchFailureMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized === "fetch failed" || normalized === "network request failed";
}

function isOAuthTransportError(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }

  if (isGenericFetchFailureMessage(error.message)) {
    return true;
  }

  return error.name === "TypeError" && error.cause !== undefined;
}

function extractOAuthTransportDetail(error: Error): string | null {
  const directMessage = isGenericFetchFailureMessage(error.message)
    ? null
    : error.message.trim() || null;
  const causeMessage = getErrorLikeMessage(error.cause);
  const causeCode = getErrorLikeCode(error.cause);

  let detail = causeMessage ?? directMessage;
  if (!detail && causeCode) {
    detail = causeCode;
  }

  if (detail && causeCode && !detail.includes(causeCode)) {
    detail = `${detail} (${causeCode})`;
  }

  return detail;
}

function toOAuthActionError(
  action: string,
  error: unknown,
  options?: { browserHint?: boolean },
): Error {
  if (isOAuthTransportError(error)) {
    const host = getOAuthAuthHost();
    const detail = extractOAuthTransportDetail(error);
    const reachabilityHint = options?.browserHint
      ? "Browser authorization may have succeeded, but the CLI could not reach Letta auth servers from this machine."
      : "The CLI could not reach Letta auth servers from this machine.";

    return new Error(
      `Failed to ${action} from ${host}${detail ? `: ${detail}` : ""}. ${reachabilityHint} Check your network, DNS, proxy, VPN, or TLS settings.`,
    );
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error(`Failed to ${action}: ${String(error)}`);
}

/**
 * Device Code Flow - Step 1: Request device code
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  const authHost = getOAuthAuthHost();
  try {
    const response = await fetch(
      `${OAUTH_CONFIG.authBaseUrl}/api/oauth/device/code`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: OAUTH_CONFIG.clientId,
        }),
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as OAuthError;
      throw new Error(
        `Failed to request device code from ${authHost}: ${error.error_description || error.error}`,
      );
    }

    return (await response.json()) as DeviceCodeResponse;
  } catch (error) {
    throw toOAuthActionError("request device code", error);
  }
}

/**
 * Device Code Flow - Step 2: Poll for token
 */
export async function pollForToken(
  deviceCode: string,
  interval: number = 5,
  expiresIn: number = 900,
  deviceId: string,
  deviceName?: string,
): Promise<TokenResponse> {
  const startTime = Date.now();
  const expiresInMs = expiresIn * 1000;
  let pollInterval = interval * 1000;

  while (Date.now() - startTime < expiresInMs) {
    await new Promise((resolve) => setTimeout(resolve, pollInterval));

    try {
      const response = await fetch(
        `${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: OAUTH_CONFIG.clientId,
            device_code: deviceCode,
            device_id: deviceId,
            ...(deviceName && { device_name: deviceName }),
          }),
        },
      );

      const result = await response.json();

      if (response.ok) {
        return result as TokenResponse;
      }

      const error = result as OAuthError;

      if (error.error === "authorization_pending") {
        // User hasn't authorized yet, keep polling
        continue;
      }

      if (error.error === "slow_down") {
        // We're polling too fast, increase interval by 5 seconds
        pollInterval += 5000;
        continue;
      }

      if (error.error === "access_denied") {
        throw new Error("User denied authorization");
      }

      if (error.error === "expired_token") {
        throw new Error("Device code expired");
      }

      throw new Error(`OAuth error: ${error.error_description || error.error}`);
    } catch (error) {
      trackBoundaryError({
        errorType: "oauth_token_poll_failed",
        error,
        context: "auth_oauth_token_poll",
      });
      if (error instanceof Error) {
        throw toOAuthActionError("poll for OAuth token", error, {
          browserHint: true,
        });
      }
      throw new Error(`Failed to poll for token: ${String(error)}`);
    }
  }

  throw new Error("Timeout waiting for authorization (15 minutes)");
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
): Promise<TokenResponse> {
  const authHost = getOAuthAuthHost();
  try {
    const response = await fetch(`${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: OAUTH_CONFIG.clientId,
        refresh_token: refreshToken,
        refresh_token_mode: "new",
        device_id: deviceId,
        ...(deviceName && { device_name: deviceName }),
      }),
    });

    if (!response.ok) {
      const error = (await response.json()) as OAuthError;
      throw new Error(
        `Failed to refresh access token from ${authHost}: ${error.error_description || error.error}`,
      );
    }

    return (await response.json()) as TokenResponse;
  } catch (error) {
    throw toOAuthActionError("refresh access token", error);
  }
}

/**
 * Revoke a refresh token (logout)
 */
export async function revokeToken(refreshToken: string): Promise<void> {
  try {
    const response = await fetch(
      `${OAUTH_CONFIG.authBaseUrl}/api/oauth/revoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: OAUTH_CONFIG.clientId,
          token: refreshToken,
          token_type_hint: "refresh_token",
        }),
      },
    );

    // OAuth 2.0 revoke endpoint should return 200 even if token is already invalid
    if (!response.ok) {
      const error = (await response.json()) as OAuthError;
      trackBoundaryError({
        errorType: "oauth_revoke_failed",
        error: error.error_description || error.error,
        context: "auth_oauth_revoke",
      });
      console.error(
        `Warning: Failed to revoke token: ${error.error_description || error.error}`,
      );
      // Don't throw - we still want to clear local credentials
    }
  } catch (error) {
    trackBoundaryError({
      errorType: "oauth_revoke_exception",
      error,
      context: "auth_oauth_revoke",
    });
    console.error("Warning: Failed to revoke token:", error);
    // Don't throw - we still want to clear local credentials
  }
}

/**
 * Validate credentials by checking health endpoint
 * Validate credentials by checking an authenticated endpoint
 * Uses SDK's agents.list() which requires valid authentication
 */
export async function validateCredentials(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  try {
    // Create a temporary client to test authentication
    const client = new Letta({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: { "X-Letta-Source": "letta-code" },
    });

    // Try to list agents - this requires valid authentication
    await client.agents.list({ limit: 1 });

    return true;
  } catch {
    return false;
  }
}
