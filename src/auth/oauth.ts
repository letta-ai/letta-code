/**
 * OAuth 2.0 utilities for Letta Cloud authentication
 * Uses Device Code Flow for CLI authentication
 */

import Letta from "@letta-ai/letta-client";
import { APIError } from "@letta-ai/letta-client/core/error";
import { trackBoundaryError } from "@/telemetry/error-reporting";

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

export class OAuthRefreshError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  readonly oauthCode?: string;

  constructor(
    message: string,
    options: {
      retryable: boolean;
      status?: number;
      oauthCode?: string;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = "OAuthRefreshError";
    this.retryable = options.retryable;
    this.status = options.status;
    this.oauthCode = options.oauthCode;
  }
}

export type CredentialValidationFailureReason =
  | "invalid_credentials"
  | "network_error"
  | "server_unreachable"
  | "unknown";

export type CredentialValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: CredentialValidationFailureReason;
      message: string;
      status?: number;
    };

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
  return (
    normalized === "fetch failed" || normalized === "network request failed"
  );
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

const DEVICE_CODE_REQUEST_MAX_ATTEMPTS = 2;
const DEVICE_CODE_RETRY_DELAY_MS = 100;
const TOKEN_POLL_RESPONSE_FAILURE_LIMIT = 2;
const OAUTH_REQUEST_ID_HEADERS = [
  "cf-ray",
  "x-request-id",
  "x-vercel-id",
] as const;

class OAuthTransientResponseError extends Error {
  readonly responseKind: "malformed JSON" | "non-JSON" | "transient HTTP";
  readonly status: number;

  constructor(
    action: string,
    response: Response,
    responseKind: "malformed JSON" | "non-JSON" | "transient HTTP",
  ) {
    const mediaType = getOAuthResponseMediaType(response);
    const requestId = getOAuthResponseRequestId(response);
    const mediaTypeText = mediaType ? `, media type ${mediaType}` : "";
    const requestIdText = requestId ? `, request id ${requestId}` : "";
    const supportHint = requestId
      ? "Try again later; if this persists, contact Letta support with this request ID."
      : "Try again later; if this persists, contact Letta support.";
    const responseDescription =
      responseKind === "transient HTTP"
        ? "transient OAuth response"
        : `${responseKind} OAuth response`;

    super(
      `Failed to ${action} from ${getOAuthAuthHost()}: received ${responseDescription} (HTTP ${response.status}${mediaTypeText}${requestIdText}). ${supportHint}`,
    );
    this.name = "OAuthTransientResponseError";
    this.responseKind = responseKind;
    this.status = response.status;
  }
}

function getOAuthResponseMediaType(response: Response): string | null {
  const contentType = response.headers.get("content-type")?.trim();
  if (!contentType) {
    return null;
  }

  return contentType.split(";", 1)[0]?.trim().toLowerCase() || null;
}

function isOAuthJsonMediaType(mediaType: string): boolean {
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

function sanitizeOAuthRequestId(value: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const sanitized = trimmed.replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128);
  return sanitized.length > 0 ? sanitized : null;
}

function getOAuthResponseRequestId(response: Response): string | null {
  for (const header of OAUTH_REQUEST_ID_HEADERS) {
    const value = sanitizeOAuthRequestId(response.headers.get(header));
    if (value) {
      return `${header}=${value}`;
    }
  }

  return null;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function isTransientOAuthResponseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function cancelOAuthResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort only: never read or surface the body in OAuth errors.
  }
}

async function parseOAuthJsonResponse(
  response: Response,
  action: string,
): Promise<unknown> {
  const mediaType = getOAuthResponseMediaType(response);
  if (mediaType && !isOAuthJsonMediaType(mediaType)) {
    await cancelOAuthResponseBody(response);
    throw new OAuthTransientResponseError(action, response, "non-JSON");
  }

  try {
    return await response.json();
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    throw new OAuthTransientResponseError(action, response, "malformed JSON");
  }
}

function waitForOAuthRetry(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  for (
    let attempt = 1;
    attempt <= DEVICE_CODE_REQUEST_MAX_ATTEMPTS;
    attempt++
  ) {
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

      const result = await parseOAuthJsonResponse(
        response,
        "request device code",
      );

      if (!response.ok) {
        if (isTransientOAuthResponseStatus(response.status)) {
          throw new OAuthTransientResponseError(
            "request device code",
            response,
            "transient HTTP",
          );
        }

        const error = result as OAuthError;
        throw new Error(
          `Failed to request device code from ${authHost}: ${error.error_description || error.error}`,
        );
      }

      return result as DeviceCodeResponse;
    } catch (error) {
      if (
        error instanceof OAuthTransientResponseError &&
        attempt < DEVICE_CODE_REQUEST_MAX_ATTEMPTS
      ) {
        await waitForOAuthRetry(DEVICE_CODE_RETRY_DELAY_MS);
        continue;
      }

      throw toOAuthActionError("request device code", error);
    }
  }

  throw new Error("Failed to request device code from unreachable OAuth path");
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
  signal?: AbortSignal,
): Promise<TokenResponse> {
  const startTime = Date.now();
  const expiresInMs = expiresIn * 1000;
  let pollInterval = interval * 1000;
  let consecutiveResponseFailures = 0;

  const sleep = async (ms: number) => {
    if (!signal) {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return;
    }

    if (signal.aborted) {
      const error = new Error("OAuth polling cancelled");
      error.name = "AbortError";
      throw error;
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const error = new Error("OAuth polling cancelled");
        error.name = "AbortError";
        reject(error);
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  while (Date.now() - startTime < expiresInMs) {
    await sleep(pollInterval);

    try {
      const response = await fetch(
        `${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`,
        {
          method: "POST",
          signal,
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

      const result = await parseOAuthJsonResponse(
        response,
        "poll for OAuth token",
      );

      if (response.ok) {
        return result as TokenResponse;
      }

      const error = result as OAuthError;

      if (error.error === "authorization_pending") {
        // User hasn't authorized yet, keep polling
        consecutiveResponseFailures = 0;
        continue;
      }

      if (error.error === "slow_down") {
        // We're polling too fast, increase interval by 5 seconds
        pollInterval += 5000;
        consecutiveResponseFailures = 0;
        continue;
      }

      if (error.error === "access_denied") {
        throw new Error("User denied authorization");
      }

      if (error.error === "expired_token") {
        throw new Error("Device code expired");
      }

      if (isTransientOAuthResponseStatus(response.status)) {
        throw new OAuthTransientResponseError(
          "poll for OAuth token",
          response,
          "transient HTTP",
        );
      }

      throw new Error(`OAuth error: ${error.error_description || error.error}`);
    } catch (error) {
      if (error instanceof OAuthTransientResponseError) {
        consecutiveResponseFailures += 1;
        if (consecutiveResponseFailures <= TOKEN_POLL_RESPONSE_FAILURE_LIMIT) {
          continue;
        }
      }

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
    const response = await fetch(
      `${OAUTH_CONFIG.authBaseUrl}/api/oauth/token`,
      {
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
      },
    );

    if (!response.ok) {
      const error = (await response.json()) as OAuthError;
      throw new OAuthRefreshError(
        `Failed to refresh access token from ${authHost}: ${error.error_description || error.error}`,
        {
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          status: response.status,
          oauthCode: error.error,
        },
      );
    }

    return (await response.json()) as TokenResponse;
  } catch (error) {
    if (error instanceof OAuthRefreshError) {
      throw error;
    }
    const actionError = toOAuthActionError("refresh access token", error);
    throw new OAuthRefreshError(actionError.message, {
      retryable: true,
      cause: error,
    });
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
 * Validate credentials by checking an authenticated endpoint.
 * Uses SDK's agents.list() which requires valid authentication.
 */
export async function validateCredentials(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  return (await validateCredentialsWithResult(baseUrl, apiKey)).ok;
}

export async function validateCredentialsWithResult(
  baseUrl: string,
  apiKey: string,
): Promise<CredentialValidationResult> {
  if (!apiKey.trim()) {
    return {
      ok: false,
      reason: "invalid_credentials",
      message: "Missing API key.",
    };
  }

  try {
    // Create a temporary client to test authentication
    const client = new Letta({
      apiKey,
      baseURL: baseUrl,
      defaultHeaders: { "X-Letta-Source": "letta-code" },
    });

    // Try to list agents - this requires valid authentication
    await client.agents.list({ limit: 1 });

    return { ok: true };
  } catch (error) {
    return classifyCredentialValidationError(error);
  }
}

function classifyCredentialValidationError(
  error: unknown,
): CredentialValidationResult {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof APIError) {
    if (error.status === 401 || error.status === 403) {
      return {
        ok: false,
        reason: "invalid_credentials",
        message,
        status: error.status,
      };
    }

    if (error.status >= 500) {
      return {
        ok: false,
        reason: "server_unreachable",
        message,
        status: error.status,
      };
    }

    return {
      ok: false,
      reason: "unknown",
      message,
      status: error.status,
    };
  }

  if (
    error instanceof TypeError ||
    message.toLowerCase().includes("fetch failed") ||
    message.toLowerCase().includes("network")
  ) {
    return { ok: false, reason: "network_error", message };
  }

  return { ok: false, reason: "unknown", message };
}
