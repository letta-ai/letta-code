/**
 * xAI Grok OAuth (SuperGrok / X Premium+)
 *
 * Browser device-code login against auth.x.ai. Access tokens are used as the
 * bearer for https://api.x.ai/v1 (same surface as API-key xAI). Public client
 * id matches the Grok CLI / Hermes integration for MVP compatibility.
 */

import {
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type OAuthProviderInterface,
  pollOAuthDeviceCodeFlow,
  registerOAuthProvider,
} from "@earendil-works/pi-ai/oauth";

export const XAI_OAUTH_PROVIDER_ID = "xai";

export const XAI_OAUTH_CONFIG = {
  issuer: "https://auth.x.ai",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  scope: "openid profile email offline_access grok-cli:access api:access",
  deviceCodeUrl: "https://auth.x.ai/oauth2/device/code",
  discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
  defaultTokenUrl: "https://auth.x.ai/oauth2/token",
  inferenceBaseUrl: "https://api.x.ai/v1",
  /** Access tokens are ~6h; refresh up to 1h early for long agent sessions. */
  refreshSkewMs: 60 * 60 * 1000,
} as const;

export type XaiOAuthCredentials = OAuthCredentials & {
  tokenEndpoint?: string;
  idToken?: string;
};

export class XaiOAuthError extends Error {
  readonly code: string;
  readonly reloginRequired: boolean;

  constructor(
    message: string,
    options: { code: string; reloginRequired?: boolean; cause?: unknown },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "XaiOAuthError";
    this.code = options.code;
    this.reloginRequired = options.reloginRequired ?? false;
  }
}

function formBody(data: Record<string, string>): URLSearchParams {
  return new URLSearchParams(data);
}

function isHttpsXaiHost(hostname: string): boolean {
  return hostname === "x.ai" || hostname.endsWith(".x.ai");
}

export function assertTrustedXaiOAuthUrl(url: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new XaiOAuthError(`Invalid ${field}: ${url}`, {
      code: "xai_discovery_invalid",
    });
  }
  if (parsed.protocol !== "https:") {
    throw new XaiOAuthError(
      `${field} must use HTTPS (got ${parsed.protocol})`,
      { code: "xai_discovery_invalid" },
    );
  }
  if (!isHttpsXaiHost(parsed.hostname)) {
    throw new XaiOAuthError(
      `${field} host must be x.ai or *.x.ai (got ${parsed.hostname})`,
      { code: "xai_discovery_invalid" },
    );
  }
  return parsed.href.replace(/\/$/, "");
}

async function readJsonResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("JSON root is not an object");
  } catch (error) {
    throw new XaiOAuthError(
      `xAI OAuth returned non-JSON (HTTP ${response.status}): ${text.slice(0, 200)}`,
      { code: "xai_oauth_invalid_json", cause: error },
    );
  }
}

function stringField(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(
  payload: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = payload[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export async function discoverXaiTokenEndpoint(
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const response = await fetchImpl(XAI_OAUTH_CONFIG.discoveryUrl, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new XaiOAuthError(
      `xAI OIDC discovery failed (HTTP ${response.status})`,
      { code: "xai_discovery_failed" },
    );
  }
  const payload = await readJsonResponse(response);
  const tokenEndpoint = stringField(payload, "token_endpoint");
  const authorizationEndpoint = stringField(payload, "authorization_endpoint");
  if (!tokenEndpoint || !authorizationEndpoint) {
    throw new XaiOAuthError("xAI OIDC discovery response incomplete", {
      code: "xai_discovery_incomplete",
    });
  }
  assertTrustedXaiOAuthUrl(authorizationEndpoint, "authorization_endpoint");
  return assertTrustedXaiOAuthUrl(tokenEndpoint, "token_endpoint");
}

export interface XaiDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export async function requestXaiDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<XaiDeviceCodeResponse> {
  const response = await fetchImpl(XAI_OAUTH_CONFIG.deviceCodeUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody({
      client_id: XAI_OAUTH_CONFIG.clientId,
      scope: XAI_OAUTH_CONFIG.scope,
    }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new XaiOAuthError(
      `xAI device-code request failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      { code: "device_code_request_failed" },
    );
  }
  const payload = await readJsonResponse(response);
  const deviceCode = stringField(payload, "device_code");
  const userCode = stringField(payload, "user_code");
  const verificationUri = stringField(payload, "verification_uri");
  const expiresIn = numberField(payload, "expires_in");
  const interval = numberField(payload, "interval");
  if (
    !deviceCode ||
    !userCode ||
    !verificationUri ||
    expiresIn === undefined ||
    interval === undefined
  ) {
    throw new XaiOAuthError(
      "xAI device-code response missing required fields",
      { code: "device_code_invalid" },
    );
  }
  const trustedUri = assertTrustedXaiOAuthUrl(
    verificationUri,
    "verification_uri",
  );
  const complete = stringField(payload, "verification_uri_complete");
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: trustedUri,
    ...(complete
      ? {
          verification_uri_complete: assertTrustedXaiOAuthUrl(
            complete,
            "verification_uri_complete",
          ),
        }
      : {}),
    expires_in: expiresIn,
    interval,
  };
}

function credentialsFromTokenPayload(
  payload: Record<string, unknown>,
  options: {
    tokenEndpoint: string;
    previousRefresh?: string;
  },
): XaiOAuthCredentials {
  const access = stringField(payload, "access_token");
  if (!access) {
    throw new XaiOAuthError("xAI token response missing access_token", {
      code: "xai_token_invalid",
      reloginRequired: true,
    });
  }
  const refresh =
    stringField(payload, "refresh_token") ?? options.previousRefresh ?? "";
  if (!refresh) {
    throw new XaiOAuthError("xAI token response missing refresh_token", {
      code: "xai_token_invalid",
      reloginRequired: true,
    });
  }
  const expiresIn = numberField(payload, "expires_in") ?? 3600;
  const idToken = stringField(payload, "id_token");
  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000 - XAI_OAUTH_CONFIG.refreshSkewMs,
    tokenEndpoint: options.tokenEndpoint,
    ...(idToken ? { idToken } : {}),
  };
}

export async function pollXaiDeviceToken(input: {
  deviceCode: string;
  tokenEndpoint: string;
  expiresIn: number;
  interval: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<XaiOAuthCredentials> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tokenEndpoint = assertTrustedXaiOAuthUrl(
    input.tokenEndpoint,
    "token_endpoint",
  );

  const credentials = await pollOAuthDeviceCodeFlow({
    intervalSeconds: input.interval,
    expiresInSeconds: input.expiresIn,
    signal: input.signal,
    poll: async () => {
      const response = await fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: formBody({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: XAI_OAUTH_CONFIG.clientId,
          device_code: input.deviceCode,
        }),
      });

      if (response.status === 200) {
        const payload = await readJsonResponse(response);
        return {
          status: "complete" as const,
          value: credentialsFromTokenPayload(payload, { tokenEndpoint }),
        };
      }

      const payload = await readJsonResponse(response).catch(() => ({}));
      const error = stringField(payload, "error") ?? "";
      if (error === "authorization_pending") {
        return { status: "pending" as const };
      }
      if (error === "slow_down") {
        return { status: "slow_down" as const };
      }
      if (response.status === 403 || error === "access_denied") {
        return {
          status: "failed" as const,
          message:
            "xAI denied OAuth access (HTTP 403). This account may not be entitled for API/OAuth use — try an XAI_API_KEY with the xAI API-key provider, or upgrade SuperGrok.",
        };
      }
      const description = stringField(payload, "error_description");
      return {
        status: "failed" as const,
        message: `xAI device-code authorization failed: ${error || `HTTP ${response.status}`}${description ? ` — ${description}` : ""}`,
      };
    },
  });
  if (!credentials) {
    throw new XaiOAuthError(
      "xAI device-code authorization returned no tokens",
      {
        code: "xai_device_token_invalid",
        reloginRequired: true,
      },
    );
  }
  return credentials;
}

export async function refreshXaiOAuthToken(
  credentials: OAuthCredentials,
  fetchImpl: typeof fetch = fetch,
): Promise<XaiOAuthCredentials> {
  const refresh = credentials.refresh;
  if (!refresh) {
    throw new XaiOAuthError("Missing xAI refresh token; re-authenticate.", {
      code: "xai_auth_missing_refresh_token",
      reloginRequired: true,
    });
  }

  const prior = credentials as XaiOAuthCredentials;
  const tokenEndpoint = assertTrustedXaiOAuthUrl(
    prior.tokenEndpoint ?? XAI_OAUTH_CONFIG.defaultTokenUrl,
    "token_endpoint",
  );

  const response = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: XAI_OAUTH_CONFIG.clientId,
    }),
  });

  if (response.status === 403) {
    const text = await response.text();
    throw new XaiOAuthError(
      `xAI token refresh failed with HTTP 403${text ? `: ${text.slice(0, 200)}` : ""}. This OAuth account is not authorized for xAI API access — xAI may restrict OAuth to specific SuperGrok tiers. Set XAI_API_KEY and connect the xAI API-key provider instead.`,
      { code: "xai_oauth_tier_denied", reloginRequired: false },
    );
  }

  if (response.status >= 400 && response.status < 500) {
    const payload = await readJsonResponse(response).catch(() => ({}));
    const error = stringField(payload, "error") ?? `HTTP ${response.status}`;
    throw new XaiOAuthError(
      `xAI token refresh failed: ${error}. Re-authenticate with /connect.`,
      {
        code: "xai_refresh_failed",
        reloginRequired: true,
      },
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new XaiOAuthError(
      `xAI token refresh failed (HTTP ${response.status})${text ? `: ${text.slice(0, 200)}` : ""}`,
      { code: "xai_refresh_failed", reloginRequired: false },
    );
  }

  const payload = await readJsonResponse(response);
  return credentialsFromTokenPayload(payload, {
    tokenEndpoint,
    previousRefresh: refresh,
  });
}

export async function loginXaiOAuth(
  callbacks: OAuthLoginCallbacks,
  fetchImpl: typeof fetch = fetch,
): Promise<XaiOAuthCredentials> {
  callbacks.onProgress?.("Discovering xAI OAuth endpoints...");
  let tokenEndpoint: string = XAI_OAUTH_CONFIG.defaultTokenUrl;
  try {
    tokenEndpoint = await discoverXaiTokenEndpoint(fetchImpl);
  } catch {
    // Fall back to the known production token endpoint if discovery fails.
    tokenEndpoint = XAI_OAUTH_CONFIG.defaultTokenUrl;
  }

  callbacks.onProgress?.("Requesting xAI device code...");
  const device = await requestXaiDeviceCode(fetchImpl);

  const verificationUri =
    device.verification_uri_complete ?? device.verification_uri;
  callbacks.onDeviceCode({
    userCode: device.user_code,
    verificationUri,
    intervalSeconds: device.interval,
    expiresInSeconds: device.expires_in,
  });

  callbacks.onProgress?.("Waiting for browser authorization...");
  return pollXaiDeviceToken({
    deviceCode: device.device_code,
    tokenEndpoint,
    expiresIn: device.expires_in,
    interval: device.interval,
    signal: callbacks.signal,
    fetchImpl,
  });
}

export function getXaiOAuthApiKey(credentials: OAuthCredentials): string {
  return credentials.access;
}

export const xaiOAuthProvider: OAuthProviderInterface = {
  id: XAI_OAUTH_PROVIDER_ID,
  name: "xAI Grok OAuth (SuperGrok)",
  async login(callbacks) {
    return loginXaiOAuth(callbacks);
  },
  async refreshToken(credentials) {
    return refreshXaiOAuthToken(credentials);
  },
  getApiKey(credentials) {
    return getXaiOAuthApiKey(credentials);
  },
};

let registered = false;

/** Idempotent registration into pi-ai's OAuth provider registry. */
export function ensureXaiOAuthProviderRegistered(): void {
  if (registered) return;
  registerOAuthProvider(xaiOAuthProvider);
  registered = true;
}

// Register on import so catalog + runtime refresh always see the provider.
ensureXaiOAuthProviderRegistered();
