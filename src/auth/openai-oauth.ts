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

export interface OAuthError {
  error: string;
  error_description?: string;
}

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Render a minimal OAuth callback page with ASCII art
 */
function renderOAuthPage(options: {
  success: boolean;
  title: string;
  message: string;
  detail?: string;
  autoClose?: boolean;
}): string {
  const { title, message, autoClose } = options;

  // ASCII art logo (escaped for HTML)
  const asciiLogo = `  ██████     ██╗     ███████╗████████╗████████╗ █████╗ 
██      ██   ██║     ██╔════╝╚══██╔══╝╚══██╔══╝██╔══██╗
██  ▇▇  ██   ██║     █████╗     ██║      ██║   ███████║
██      ██   ██║     ██╔══╝     ██║      ██║   ██╔══██║
  ██████     ███████╗███████╗   ██║      ██║   ██║  ██║
  ╚═════╝    ╚══════╝╚══════╝   ╚═╝      ╚═╝   ╚═╝  ╚═╝`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - Letta Code</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      background: #161616;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 64px;
    }
    .container {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }
    .ascii-art {
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', 'Consolas', monospace;
      font-size: 12px;
      line-height: 1.2;
      color: #404040;
      white-space: pre;
      user-select: none;
      margin-bottom: 48px;
    }
    .title {
      font-size: 32px;
      font-weight: 600;
      color: #e5e5e5;
      margin-bottom: 12px;
      letter-spacing: -0.02em;
    }
    .message {
      font-size: 16px;
      color: #737373;
      line-height: 1.5;
    }
    @media (max-width: 600px) {
      .ascii-art { font-size: 8px; }
      .title { font-size: 24px; }
      .message { font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="ascii-art">${asciiLogo}</div>
    <h1 class="title">${title}</h1>
    <p class="message">${message}</p>
  </div>
  ${autoClose ? `<script>setTimeout(() => window.close(), 2000);</script>` : ""}
</body>
</html>`;
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
    const authClaim = payload["https://api.openai.com/auth"] as
      | Record<string, unknown>
      | undefined;
    if (authClaim && typeof authClaim.chatgpt_account_id === "string") {
      return authClaim.chatgpt_account_id;
    }
    throw new Error("chatgpt_account_id not found in token claims");
  } catch (error) {
    throw new Error(
      `Failed to extract account ID from token: ${error instanceof Error ? error.message : String(error)}`,
    );
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
          res.end(
            renderOAuthPage({
              success: false,
              title: "Authentication Failed",
              message: `Error: ${error}`,
              detail: errorDescription || undefined,
            }),
          );
          reject(
            new Error(`OAuth error: ${error} - ${errorDescription || ""}`),
          );
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            renderOAuthPage({
              success: false,
              title: "Authentication Failed",
              message: "Missing authorization code or state parameter.",
            }),
          );
          reject(new Error("Missing authorization code or state parameter"));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(
            renderOAuthPage({
              success: false,
              title: "Authentication Failed",
              message:
                "State mismatch - the authorization may have been tampered with.",
            }),
          );
          reject(
            new Error(
              "State mismatch - the authorization may have been tampered with",
            ),
          );
          return;
        }

        // Success!
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          renderOAuthPage({
            success: true,
            title: "Authorization Successful",
            message: "You can close this window and return to Letta Code.",
            autoClose: true,
          }),
        );

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
