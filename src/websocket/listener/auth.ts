import {
  LETTA_CLOUD_API_URL,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
} from "@/auth/oauth";
import { settingsManager } from "@/settings-manager";
import {
  deriveListenerInstanceId,
  type RegisterOptions,
} from "@/websocket/listen-register";

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

const defaultListenerOAuthDeps: ListenerOAuthDeps = {
  LETTA_CLOUD_API_URL,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
};

let listenerOAuthDepsOverride: ListenerOAuthDeps | null = null;
const listenerTokenRefreshes = new Map<string, Promise<string>>();

function getListenerOAuthDeps(): ListenerOAuthDeps {
  return listenerOAuthDepsOverride ?? defaultListenerOAuthDeps;
}

export class MissingListenerApiKeyError extends Error {
  constructor() {
    super("LETTA_API_KEY not found");
    this.name = "MissingListenerApiKeyError";
  }
}

export class ListenerTokenRefreshError extends Error {
  readonly refreshError: unknown;

  constructor(refreshError: unknown) {
    const message =
      refreshError instanceof Error
        ? refreshError.message
        : String(refreshError);
    super(
      `Saved Letta Cloud credentials could not be refreshed: ${message}. Run letta server again to sign in, or set LETTA_API_KEY.`,
    );
    this.name = "ListenerTokenRefreshError";
    this.refreshError = refreshError;
  }
}

export function getListenerServerUrl(settings: {
  env?: Record<string, string>;
}): string {
  const oauthDeps = getListenerOAuthDeps();
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    oauthDeps.LETTA_CLOUD_API_URL
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

  const expiresAt = settings.tokenExpiresAt;
  if (!expiresAt) {
    return false;
  }

  return Date.now() >= expiresAt - LISTENER_TOKEN_REFRESH_WINDOW_MS;
}

async function refreshListenerAccessToken(
  settings: ListenerSettings,
  deviceId: string,
  connectionName: string,
): Promise<string> {
  const refreshToken = settings.refreshToken;
  if (!refreshToken) {
    throw new MissingListenerApiKeyError();
  }

  const refreshKey = `${refreshToken}\0${deviceId}\0${connectionName}`;
  const existingRefresh = listenerTokenRefreshes.get(refreshKey);
  if (existingRefresh) {
    return await existingRefresh;
  }

  const refreshPromise = (async () => {
    const oauthDeps = getListenerOAuthDeps();
    const now = Date.now();

    console.log("Access token expired, refreshing...");

    const tokens = await oauthDeps.refreshAccessToken(
      refreshToken,
      deviceId,
      connectionName,
    );

    settingsManager.updateSettings({
      env: { LETTA_API_KEY: tokens.access_token },
      tokenExpiresAt: now + tokens.expires_in * 1000,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    });
    await settingsManager.flush();

    console.log("Token refreshed successfully.");

    return tokens.access_token;
  })();

  listenerTokenRefreshes.set(refreshKey, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    listenerTokenRefreshes.delete(refreshKey);
  }
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
    tokenExpiresAt: now + tokens.expires_in * 1000,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
  });
  await settingsManager.flush();

  console.log("Authenticated successfully.\n");

  return tokens.access_token;
}

export async function resolveListenerRegistrationOptions(
  deviceId: string,
  connectionName: string,
  options: { allowInteractiveOAuth?: boolean } = {},
): Promise<RegisterOptions> {
  const allowInteractiveOAuth = options.allowInteractiveOAuth ?? true;
  const settings = await settingsManager.getSettingsWithSecureTokens();
  const serverUrl = getListenerServerUrl(settings);
  const envApiKey = process.env.LETTA_API_KEY;

  if (envApiKey) {
    return {
      serverUrl,
      apiKey: envApiKey,
      deviceId,
      connectionName,
      listenerInstanceId: deriveListenerInstanceId("server", connectionName),
    };
  }

  let apiKey = settings.env?.LETTA_API_KEY;

  if (isCloudListenerServerUrl(serverUrl)) {
    if (shouldRefreshListenerAccessToken(settings, apiKey)) {
      try {
        apiKey = await refreshListenerAccessToken(
          settings,
          deviceId,
          connectionName,
        );
      } catch (refreshErr) {
        if (!allowInteractiveOAuth) {
          throw new ListenerTokenRefreshError(refreshErr);
        }

        console.warn(
          "Token refresh failed:",
          refreshErr instanceof Error ? refreshErr.message : String(refreshErr),
        );
        apiKey = undefined;
      }
    }

    if (!apiKey && allowInteractiveOAuth) {
      apiKey = await runListenerOAuthLogin(deviceId, connectionName);
    }
  }

  if (!apiKey) {
    throw new MissingListenerApiKeyError();
  }

  return {
    serverUrl,
    apiKey,
    deviceId,
    connectionName,
    listenerInstanceId: deriveListenerInstanceId("server", connectionName),
  };
}

export async function resolveListenerReconnectApiKey(
  deviceId: string,
  connectionName: string,
  onMissingCredentials?: () => void,
): Promise<string | null> {
  try {
    return (
      await resolveListenerRegistrationOptions(deviceId, connectionName, {
        allowInteractiveOAuth: false,
      })
    ).apiKey;
  } catch (error) {
    if (error instanceof MissingListenerApiKeyError && onMissingCredentials) {
      onMissingCredentials();
      return null;
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
  clearInFlightRefreshesForTests() {
    listenerTokenRefreshes.clear();
  },
};
