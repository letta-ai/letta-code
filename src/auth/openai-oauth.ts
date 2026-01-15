/**
 * OAuth 2.0 utilities for OpenAI Codex authentication
 * Uses Authorization Code Flow with PKCE and local callback server
 * Compatible with Codex CLI authentication flow
 */

import http from "node:http";

export const OPENAI_OAUTH_CONFIG = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizationUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  defaultPort: 1455,
  callbackPath: "/auth/callback",
  scope: "openid profile email offline_access",
} as const;

export interface OpenAITokens {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

export interface OpenAIApiKeyResponse {
  access_token: string; // This is the API key
  token_type: string;
}

export interface OAuthError {
  error: string;
  error_description?: string;
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
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
 * Decode JWT payload (no signature verification - for local extraction only)
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const payload = parts[1];
  if (!payload) {
    throw new Error("Missing JWT payload");
  }
  // Handle base64url encoding
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const decoded = atob(padded);
  return JSON.parse(decoded);
}

/**
 * Extract ChatGPT Account ID from access token JWT
 * The account ID is in the custom claim: https://api.openai.com/auth.chatgpt_account_id
 */
export function extractAccountIdFromToken(accessToken: string): string {
  try {
    const payload = decodeJwtPayload(accessToken);
    // The account ID is in the custom claim path
    const authClaim = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
    if (authClaim && typeof authClaim.chatgpt_account_id === "string") {
      return authClaim.chatgpt_account_id;
    }
    throw new Error("chatgpt_account_id not found in token claims");
  } catch (error) {
    throw new Error(`Failed to extract account ID from token: ${error instanceof Error ? error.message : String(error)}`);
  }
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
 * Start a local HTTP server to receive OAuth callback
 * Returns a promise that resolves with the authorization code when received
 */
export function startLocalOAuthServer(
  expectedState: string,
  port = OPENAI_OAUTH_CONFIG.defaultPort,
): Promise<{ result: OAuthCallbackResult; server: http.Server }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "", `http://localhost:${port}`);

      if (url.pathname === OPENAI_OAUTH_CONFIG.callbackPath) {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Authentication Failed</h1>
                <p>Error: ${error}</p>
                <p>${errorDescription || ""}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          reject(
            new Error(`OAuth error: ${error} - ${errorDescription || ""}`),
          );
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Authentication Failed</h1>
                <p>Missing authorization code or state parameter.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          reject(new Error("Missing authorization code or state parameter"));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body>
                <h1>Authentication Failed</h1>
                <p>State mismatch - the authorization may have been tampered with.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          reject(
            new Error(
              "State mismatch - the authorization may have been tampered with",
            ),
          );
          return;
        }

        // Success!
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(`
          <html>
            <body>
              <h1>Authentication Successful!</h1>
              <p>You have successfully connected to OpenAI Codex.</p>
              <p>You can close this window and return to Letta Code.</p>
              <script>setTimeout(() => window.close(), 2000);</script>
            </body>
          </html>
        `);

        resolve({ result: { code, state }, server });
      } else {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
      }
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${port} is already in use. Please close any application using this port and try again.`,
          ),
        );
      } else {
        reject(err);
      }
    });

    server.listen(port, "127.0.0.1", () => {
      // Server started successfully, waiting for callback
    });

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close();
        reject(
          new Error("OAuth timeout - no callback received within 5 minutes"),
        );
      },
      5 * 60 * 1000,
    );
  });
}

/**
 * Start OAuth flow - returns authorization URL and PKCE values
 * Also starts local server to receive callback
 */
export async function startOpenAIOAuth(
  port = OPENAI_OAUTH_CONFIG.defaultPort,
): Promise<{
  authorizationUrl: string;
  state: string;
  codeVerifier: string;
  redirectUri: string;
}> {
  const state = generateState();
  const { codeVerifier, codeChallenge } = await generatePKCE();
  const redirectUri = `http://localhost:${port}${OPENAI_OAUTH_CONFIG.callbackPath}`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CONFIG.clientId,
    redirect_uri: redirectUri,
    scope: OPENAI_OAUTH_CONFIG.scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  });

  const authorizationUrl = `${OPENAI_OAUTH_CONFIG.authorizationUrl}?${params.toString()}`;

  return {
    authorizationUrl,
    state,
    codeVerifier,
    redirectUri,
  };
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<OpenAITokens> {
  const response = await fetch(OPENAI_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: OPENAI_OAUTH_CONFIG.clientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to exchange code for tokens (HTTP ${response.status}): ${errorText}`,
    );
  }

  return (await response.json()) as OpenAITokens;
}

/**
 * Exchange OAuth tokens for OpenAI API key using token-exchange grant
 */
export async function exchangeTokenForApiKey(idToken: string): Promise<string> {
  const response = await fetch(OPENAI_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      requested_token: "openai-api-key",
      subject_token: idToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      client_id: OPENAI_OAUTH_CONFIG.clientId,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to exchange token for API key (HTTP ${response.status}): ${errorText}`,
    );
  }

  const data = (await response.json()) as OpenAIApiKeyResponse;
  return data.access_token;
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshOpenAIToken(
  refreshToken: string,
): Promise<OpenAITokens> {
  const response = await fetch(OPENAI_OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: OPENAI_OAUTH_CONFIG.clientId,
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

  return (await response.json()) as OpenAITokens;
}

/**
 * Validate credentials by making a test API call
 */
export async function validateOpenAICredentials(
  apiKey: string,
): Promise<boolean> {
  try {
    // Use the models endpoint to validate the API key
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get a valid OpenAI API key, refreshing tokens if necessary
 * Returns null if no OAuth tokens are configured
 */
export async function getOpenAIApiKey(): Promise<string | null> {
  // Lazy import to avoid circular dependencies
  const { settingsManager } = await import("../settings-manager");

  const tokens = settingsManager.getOpenAITokens();
  if (!tokens) {
    return null;
  }

  // If we already have an API key and tokens aren't expired, return it
  if (tokens.api_key && !settingsManager.isOpenAITokenExpired()) {
    return tokens.api_key;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  if (tokens.expires_at < fiveMinutesFromNow && tokens.refresh_token) {
    try {
      const newTokens = await refreshOpenAIToken(tokens.refresh_token);
      // Get new API key from refreshed tokens
      const apiKey = await exchangeTokenForApiKey(newTokens.id_token);
      settingsManager.storeOpenAITokens(newTokens, apiKey);
      return apiKey;
    } catch (error) {
      console.error("Failed to refresh OpenAI access token:", error);
      // Return existing API key even if refresh failed - it might still work
      return tokens.api_key || null;
    }
  }

  return tokens.api_key || null;
}

/**
 * Check if OpenAI OAuth is configured and valid
 */
export async function hasValidOpenAIAuth(): Promise<boolean> {
  const apiKey = await getOpenAIApiKey();
  if (!apiKey) {
    return false;
  }
  return validateOpenAICredentials(apiKey);
}
