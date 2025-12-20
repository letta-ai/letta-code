/**
 * OAuth 2.0 utilities for Anthropic authentication
 * Uses Authorization Code Flow with PKCE
 */

export const ANTHROPIC_OAUTH_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorizationUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://console.anthropic.com/v1/oauth/token",
  redirectUri: "https://console.anthropic.com/oauth/code/callback",
  scope: "org:create_api_key user:profile user:inference",
} as const;

export interface AnthropicTokens {
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
 * Generate PKCE code verifier (43-128 characters of unreserved URI characters)
 */
export function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

/**
 * Generate PKCE code challenge from verifier using SHA-256
 */
export async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

/**
 * Generate cryptographically secure state parameter (32-byte hex)
 */
export function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Base64 URL encode (RFC 4648)
 */
function base64UrlEncode(buffer: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...buffer));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Generate PKCE code verifier and challenge
 */
export async function generatePKCE(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  return { codeVerifier, codeChallenge };
}

/**
 * Start OAuth flow - returns authorization URL and PKCE values
 */
export async function startAnthropicOAuth(): Promise<{
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
}> {
  const state = generateState();
  const { codeVerifier, codeChallenge } = await generatePKCE();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: ANTHROPIC_OAUTH_CONFIG.clientId,
    redirect_uri: ANTHROPIC_OAUTH_CONFIG.redirectUri,
    scope: ANTHROPIC_OAUTH_CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });

  const authorizationUrl = `${ANTHROPIC_OAUTH_CONFIG.authorizationUrl}?${params.toString()}`;

  return {
    authorizationUrl,
    state,
    codeVerifier,
  };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  state: string,
): Promise<AnthropicTokens> {
  const response = await fetch(ANTHROPIC_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CONFIG.clientId,
      code,
      state,
      redirect_uri: ANTHROPIC_OAUTH_CONFIG.redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Show full response for debugging
    throw new Error(
      `Failed to exchange code for tokens (HTTP ${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as AnthropicTokens;
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<AnthropicTokens> {
  const response = await fetch(ANTHROPIC_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const error = (await response.json().catch(() => ({
      error: "unknown_error",
      error_description: `HTTP ${response.status}`,
    }))) as OAuthError;
    throw new Error(
      `Failed to refresh access token: ${error.error_description || error.error}`,
    );
  }

  return (await response.json()) as AnthropicTokens;
}

/**
 * Validate credentials by making a test API call
 * OAuth tokens require the anthropic-beta header
 */
export async function validateAnthropicCredentials(
  accessToken: string,
): Promise<boolean> {
  try {
    // Use the models endpoint to validate the token
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get a valid Anthropic access token, refreshing if necessary
 * Returns null if no OAuth tokens are configured
 */
export async function getAnthropicAccessToken(): Promise<string | null> {
  // Lazy import to avoid circular dependencies
  const { settingsManager } = await import("../settings-manager");

  const tokens = settingsManager.getAnthropicTokens();
  if (!tokens) {
    return null;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (tokens.expires_at < fiveMinutesFromNow && tokens.refresh_token) {
    try {
      const newTokens = await refreshAnthropicToken(tokens.refresh_token);
      settingsManager.storeAnthropicTokens(newTokens);
      return newTokens.access_token;
    } catch (error) {
      console.error("Failed to refresh Anthropic access token:", error);
      // Return existing token even if refresh failed - it might still work
      return tokens.access_token;
    }
  }

  return tokens.access_token;
}

/**
 * Check if Anthropic OAuth is configured and valid
 */
export async function hasValidAnthropicAuth(): Promise<boolean> {
  const token = await getAnthropicAccessToken();
  if (!token) {
    return false;
  }
  return validateAnthropicCredentials(token);
}
