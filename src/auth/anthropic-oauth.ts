/**
 * OAuth 2.0 utilities for Anthropic Claude Max subscription authentication
 * Uses Authorization Code Flow with PKCE (same as Claude Code / OpenCode)
 *
 * This allows users to use their Claude Pro/Max subscription directly
 * without needing separate API keys.
 */

import { createHash, randomBytes } from "node:crypto";
import open from "open";

// Anthropic OAuth configuration (same client ID as Claude Code / OpenCode)
export const ANTHROPIC_OAUTH_CONFIG = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  // OpenCode uses claude.ai for auth, console.anthropic.com for tokens
  authorizationEndpoint: "https://claude.ai/oauth/authorize",
  tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  apiBaseUrl: "https://api.anthropic.com",
  // Scopes needed for API access (same as OpenCode/Claude Code)
  scopes: ["org:create_api_key", "user:profile", "user:inference"],
} as const;

export interface AnthropicTokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

export interface AnthropicOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Generate a cryptographically secure random string for PKCE
 */
function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generate code challenge from verifier using SHA256
 */
function generateCodeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Generate a random state parameter for CSRF protection
 */
function generateState(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Start OAuth flow for Anthropic Claude Max subscription
 * Uses Anthropic's hosted callback page, then user pastes the code
 */
export async function anthropicOAuthLogin(): Promise<AnthropicOAuthCredentials> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Use Anthropic's hosted callback (same as OpenCode)
  const redirectUri = "https://console.anthropic.com/oauth/code/callback";

  // Build authorization URL (matching OpenCode's format exactly)
  const authUrl = new URL(ANTHROPIC_OAUTH_CONFIG.authorizationEndpoint);
  authUrl.searchParams.set("code", "true");
  authUrl.searchParams.set("client_id", ANTHROPIC_OAUTH_CONFIG.clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("scope", ANTHROPIC_OAUTH_CONFIG.scopes.join(" "));
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);

  console.log("\n🔐 Opening browser for Anthropic authorization...");
  console.log(
    `\nIf the browser doesn't open, visit this URL:\n${authUrl.toString()}\n`,
  );

  // Open browser
  await open(authUrl.toString()).catch(() => {
    // Browser open failed, user will use the printed URL
  });

  // Prompt user to paste the authorization code
  console.log("After authorizing, you'll see an authorization code.");
  console.log("Paste the code here and press Enter:\n");

  const rawInput = await readLine();

  if (!rawInput || rawInput.trim() === "") {
    throw new Error("No authorization code provided");
  }

  // The pasted value contains code#state - split them
  const splits = rawInput.trim().split("#");
  const code = splits[0];
  const returnedState = splits[1];

  // Exchange authorization code for tokens (matching OpenCode's exact format)
  const tokenResponse = await fetch(ANTHROPIC_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      code: code,
      state: returnedState,
      grant_type: "authorization_code",
      client_id: ANTHROPIC_OAUTH_CONFIG.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${errorBody}`);
  }

  const tokens = (await tokenResponse.json()) as AnthropicTokenResponse;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

/**
 * Read a line from stdin
 */
function readLine(): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;

    stdin.setEncoding("utf8");
    stdin.resume();

    let input = "";

    const onData = (chunk: string) => {
      input += chunk;
      if (input.includes("\n")) {
        stdin.removeListener("data", onData);
        stdin.pause();
        resolve(input.trim());
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Refresh an Anthropic access token using a refresh token
 */
export async function refreshAnthropicToken(
  refreshToken: string,
): Promise<AnthropicOAuthCredentials> {
  const response = await fetch(ANTHROPIC_OAUTH_CONFIG.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_id: ANTHROPIC_OAUTH_CONFIG.clientId,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Token refresh failed: ${errorBody}`);
  }

  const tokens = (await response.json()) as AnthropicTokenResponse;

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || refreshToken, // Use new refresh token if provided
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

/**
 * Make an authenticated request to Anthropic API using OAuth token
 * This is used instead of API key authentication
 */
export async function anthropicFetch(
  endpoint: string,
  options: RequestInit,
  accessToken: string,
): Promise<Response> {
  const url = `${ANTHROPIC_OAUTH_CONFIG.apiBaseUrl}${endpoint}`;

  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("anthropic-beta", "oauth-2025-04-20");
  headers.set("anthropic-version", "2023-06-01");
  headers.set("Content-Type", "application/json");

  // Remove x-api-key if present (not used with OAuth)
  headers.delete("x-api-key");

  return fetch(url, {
    ...options,
    headers,
  });
}

/**
 * Validate Anthropic OAuth credentials by making a test API call
 */
export async function validateAnthropicCredentials(
  accessToken: string,
): Promise<boolean> {
  try {
    // Make a minimal API call to verify the token works
    const response = await anthropicFetch(
      "/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      accessToken,
    );

    // 200 = success, 400 = bad request (but auth worked), 529 = overloaded (but auth worked)
    return (
      response.status === 200 ||
      response.status === 400 ||
      response.status === 529
    );
  } catch {
    return false;
  }
}
