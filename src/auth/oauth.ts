/**
 * OAuth 2.0 utilities for Letta Cloud authentication
 * Uses Device Code Flow for CLI authentication
 */

import Letta from "@letta-ai/letta-client";

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

/**
 * Device Code Flow - Step 1: Request device code
 */
export async function requestDeviceCode(): Promise<DeviceCodeResponse> {
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
      `Failed to request device code: ${error.error_description || error.error}`,
    );
  }

  return (await response.json()) as DeviceCodeResponse;
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
      if (error instanceof Error) {
        throw error;
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
  const response = await fetch(`${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
      refresh_token_mode: "new",
      ...(deviceId && { device_id: deviceId }),
      ...(deviceName && { device_name: deviceName }),
    }),
  });

  if (!response.ok) {
    const error = (await response.json()) as OAuthError;
    throw new Error(
      `Failed to refresh access token: ${error.error_description || error.error}`,
    );
  }

  return (await response.json()) as TokenResponse;
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
      console.error(
        `Warning: Failed to revoke token: ${error.error_description || error.error}`,
      );
      // Don't throw - we still want to clear local credentials
    }
  } catch (error) {
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
