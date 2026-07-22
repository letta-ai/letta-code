import {
  LETTA_CLOUD_API_URL,
  OAuthRefreshError,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
} from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";
import { settingsManager } from "@/settings-manager";
import {
  deriveListenerInstanceId,
  type ListenerSurface,
  type RegisterOptions,
  resolveListenerSurfaceFromEnv,
} from "@/websocket/listen-register";
import type { StartListenerOptions } from "@/websocket/listener/types";

const LISTENER_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

type ListenerOAuthDeps = {
  LETTA_CLOUD_API_URL: string;
  pollForToken: typeof pollForToken;
  refreshAccessToken: typeof refreshAccessToken;
  requestDeviceCode: typeof requestDeviceCode;
};

type ListenerAuthOptions = {
  allowInteractiveOAuth?: boolean;
};

type ListenerRegistrationOptions = ListenerAuthOptions & {
  surface?: ListenerSurface;
  /**
   * Session-scoped registration nonce (createListenerSessionNonce()).
   * Callers pass the SAME nonce for a session's initial registration and
   * all of its re-registrations, and a fresh nonce for each new session.
   */
  sessionNonce?: string;
};

const defaultListenerOAuthDeps: ListenerOAuthDeps = {
  LETTA_CLOUD_API_URL,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
};

let listenerOAuthDepsOverride: ListenerOAuthDeps | null = null;

function getListenerOAuthDeps(): ListenerOAuthDeps {
  return listenerOAuthDepsOverride ?? defaultListenerOAuthDeps;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class MissingListenerApiKeyError extends Error {
  constructor() {
    super("LETTA_API_KEY not found");
    this.name = "MissingListenerApiKeyError";
  }
}

class ListenerAuthRetryableError extends Error {
  constructor(refreshError: unknown) {
    super(
      `Could not refresh listener credentials: ${errorMessage(refreshError)}`,
    );
    this.name = "ListenerAuthRetryableError";
  }
}

export class ListenerReauthenticationRequiredError extends Error {
  constructor(refreshError?: unknown) {
    const detail = refreshError ? `: ${errorMessage(refreshError)}` : "";
    super(
      `Saved Letta API credentials require reauthentication${detail}. Run letta to sign in again, or set LETTA_API_KEY.`,
    );
    this.name = "ListenerReauthenticationRequiredError";
  }
}

export function getListenerServerUrl(settings: {
  env?: Record<string, string>;
}): string {
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    getListenerOAuthDeps().LETTA_CLOUD_API_URL
  );
}

function normalizeListenerBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

export function isCloudListenerServerUrl(serverUrl: string): boolean {
  return (
    normalizeListenerBaseUrl(serverUrl) ===
    normalizeListenerBaseUrl(getListenerOAuthDeps().LETTA_CLOUD_API_URL)
  );
}

function shouldRefreshListenerAccessToken(
  settings: ListenerSettings,
  apiKey: string | undefined,
): boolean {
  if (!settings.refreshToken) {
    return false;
  }
  if (!apiKey) {
    return true;
  }
  return (
    settings.tokenExpiresAt !== undefined &&
    Date.now() >= settings.tokenExpiresAt - LISTENER_TOKEN_REFRESH_WINDOW_MS
  );
}

function isAccessTokenStillValid(
  settings: ListenerSettings,
  apiKey: string | undefined,
): apiKey is string {
  return Boolean(
    apiKey &&
      (settings.tokenExpiresAt === undefined ||
        Date.now() < settings.tokenExpiresAt),
  );
}

async function refreshListenerAccessToken(
  settings: ListenerSettings,
  deviceId: string,
  connectionName: string,
): Promise<string> {
  if (!settings.refreshToken) {
    throw new MissingListenerApiKeyError();
  }

  const now = Date.now();
  console.log("Access token expired, refreshing...");

  const tokens = await refreshAccessTokenSingleFlight(
    settings.refreshToken,
    deviceId,
    connectionName,
    getListenerOAuthDeps().refreshAccessToken,
  );

  settingsManager.updateSettings({
    env: { LETTA_API_KEY: tokens.access_token },
    refreshToken: tokens.refresh_token ?? settings.refreshToken,
    tokenExpiresAt: now + tokens.expires_in * 1000,
  });
  await settingsManager.flush();

  console.log("Token refreshed successfully.");
  return tokens.access_token;
}

async function runListenerOAuthLogin(
  deviceId: string,
  connectionName: string,
): Promise<string> {
  const oauthDeps = getListenerOAuthDeps();
  console.log("No API key found. Starting OAuth login...\n");

  const deviceData = await oauthDeps.requestDeviceCode();
  console.log(
    `To authenticate, visit: ${deviceData.verification_uri_complete}`,
  );
  console.log(`Your code: ${deviceData.user_code}\n`);
  console.log("Waiting for authorization...\n");

  const tokens = await oauthDeps.pollForToken(
    deviceData.device_code,
    deviceData.interval,
    deviceData.expires_in,
    deviceId,
    connectionName,
  );
  const now = Date.now();

  settingsManager.updateSettings({
    env: { LETTA_API_KEY: tokens.access_token },
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    tokenExpiresAt: now + tokens.expires_in * 1000,
  });
  await settingsManager.flush();

  console.log("Authenticated successfully.\n");
  return tokens.access_token;
}

async function resolveListenerAuth(
  deviceId: string,
  connectionName: string,
  options: ListenerAuthOptions,
): Promise<{ serverUrl: string; apiKey: string }> {
  const allowInteractiveOAuth = options.allowInteractiveOAuth ?? true;
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const serverUrl = getListenerServerUrl(settings);
  const envApiKey = process.env.LETTA_API_KEY;

  if (envApiKey) {
    return { serverUrl, apiKey: envApiKey };
  }

  let apiKey = settings.env?.LETTA_API_KEY;
  if (!isCloudListenerServerUrl(serverUrl)) {
    if (!apiKey) {
      throw new MissingListenerApiKeyError();
    }
    return { serverUrl, apiKey };
  }

  if (shouldRefreshListenerAccessToken(settings, apiKey)) {
    try {
      apiKey = await refreshListenerAccessToken(
        settings,
        deviceId,
        connectionName,
      );
    } catch (refreshError) {
      const retryable =
        !(refreshError instanceof OAuthRefreshError) || refreshError.retryable;
      if (retryable && isAccessTokenStillValid(settings, apiKey)) {
        console.warn(
          `Token refresh failed; using the current access token: ${errorMessage(refreshError)}`,
        );
        return { serverUrl, apiKey };
      }
      if (retryable) {
        throw new ListenerAuthRetryableError(refreshError);
      }
      if (!allowInteractiveOAuth) {
        throw new ListenerReauthenticationRequiredError(refreshError);
      }

      console.warn(`Token refresh failed: ${errorMessage(refreshError)}`);
      apiKey = undefined;
    }
  }

  if (!apiKey) {
    if (!allowInteractiveOAuth) {
      throw new ListenerReauthenticationRequiredError();
    }
    apiKey = await runListenerOAuthLogin(deviceId, connectionName);
  }

  return { serverUrl, apiKey };
}

export async function resolveListenerRegistrationOptions(
  deviceId: string,
  connectionName: string,
  options: ListenerRegistrationOptions = {},
): Promise<RegisterOptions> {
  const auth = await resolveListenerAuth(deviceId, connectionName, options);
  return {
    ...auth,
    deviceId,
    connectionName,
    // The spawner may override the surface via LETTA_LISTENER_SURFACE (e.g.
    // Desktop registers its cloud listener as "desktop-remote") so it gets
    // a distinct environment slot from a manual `letta server` with the
    // same connection name (LET-10024).
    listenerInstanceId: deriveListenerInstanceId(
      resolveListenerSurfaceFromEnv(options.surface ?? "server"),
      connectionName,
    ),
    ...(options.sessionNonce ? { sessionNonce: options.sessionNonce } : {}),
  };
}

export async function resolveListenerReconnectAuth(
  options: Pick<StartListenerOptions, "deviceId" | "connectionName">,
): Promise<{ kind: "ready"; apiKey: string } | { kind: "retry" }> {
  try {
    const auth = await resolveListenerAuth(
      options.deviceId,
      options.connectionName,
      { allowInteractiveOAuth: false },
    );
    return { kind: "ready", apiKey: auth.apiKey };
  } catch (error) {
    if (error instanceof ListenerAuthRetryableError) {
      return { kind: "retry" };
    }
    throw error;
  }
}

export const __listenerAuthTestUtils = {
  setOAuthDepsForTests(overrides: Partial<ListenerOAuthDeps> | null) {
    listenerOAuthDepsOverride = overrides
      ? {
          ...defaultListenerOAuthDeps,
          ...overrides,
        }
      : null;
  },
};
