import { getDesktopAccessToken } from "@/auth/desktop-credentials";
import {
  LETTA_CLOUD_API_URL,
  OAuthRefreshError,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
} from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";
import { activateOrgCredentials } from "@/auth/org-credentials-session";
import { settingsManager } from "@/settings-manager";
import { debugLog } from "@/utils/debug";
import {
  deriveListenerInstanceId,
  type RegisterOptions,
} from "@/websocket/listen-register";
import { getSpawnerListenerInstanceId } from "@/websocket/listener/identity";
import {
  type OrgCredentials,
  orgCredentialStore,
} from "@/websocket/listener/org-credentials";
import type { StartListenerOptions } from "@/websocket/listener/types";

const LISTENER_TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

type ListenerSettings = Awaited<
  ReturnType<typeof settingsManager.getSettingsWithSecureTokens>
>;

/**
 * Where a listener's cloud credentials live. The global slot is the sign-in
 * shared with `letta`; an organization slot belongs to one `--org` listener.
 */
type CredentialSlot = {
  read(): Promise<OrgCredentials>;
  write(credentials: OrgCredentials & { apiKey: string }): Promise<void>;
};

function globalCredentialSlot(settings: ListenerSettings): CredentialSlot {
  return {
    async read() {
      return {
        apiKey: settings.env?.LETTA_API_KEY,
        refreshToken: settings.refreshToken,
        tokenExpiresAt: settings.tokenExpiresAt,
      };
    },
    async write(credentials) {
      settingsManager.updateSettings({
        env: { LETTA_API_KEY: credentials.apiKey },
        refreshToken: credentials.refreshToken,
        tokenExpiresAt: credentials.tokenExpiresAt,
      });
      await settingsManager.flush();
    },
  };
}

function orgCredentialSlot(organizationId: string): CredentialSlot {
  return {
    read: () => orgCredentialStore.load(organizationId),
    write: (credentials) =>
      orgCredentialStore.save(organizationId, credentials),
  };
}

type ListenerOAuthDeps = {
  LETTA_CLOUD_API_URL: string;
  pollForToken: typeof pollForToken;
  refreshAccessToken: typeof refreshAccessToken;
  requestDeviceCode: typeof requestDeviceCode;
  openInBrowser: (url: string) => void;
};

type ListenerAuthOptions = {
  allowInteractiveOAuth?: boolean;
  /**
   * Sign in to this organization specifically. Credentials live in a slot
   * keyed by the organization, so the global sign-in is neither used nor
   * replaced.
   */
  organizationId?: string;
};

type ListenerRegistrationOptions = ListenerAuthOptions & {
  surface?: "server" | "listen";
};

/**
 * Best-effort: open the device-auth page so a first-time user does not have
 * to copy the URL out of the terminal. The URL is always printed as fallback.
 */
function openInBrowser(url: string): void {
  import("open")
    .then(({ default: open }) => open(url, { wait: false }))
    .then((subprocess) => {
      subprocess.on("error", () => {
        // User can visit the printed URL manually.
      });
    })
    .catch(() => {
      // User can visit the printed URL manually.
    });
}

const defaultListenerOAuthDeps: ListenerOAuthDeps = {
  LETTA_CLOUD_API_URL,
  pollForToken,
  refreshAccessToken,
  requestDeviceCode,
  openInBrowser,
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
  credentials: OrgCredentials,
): boolean {
  if (!credentials.refreshToken) {
    return false;
  }
  if (!credentials.apiKey) {
    return true;
  }
  return (
    credentials.tokenExpiresAt !== undefined &&
    Date.now() >= credentials.tokenExpiresAt - LISTENER_TOKEN_REFRESH_WINDOW_MS
  );
}

function isAccessTokenStillValid(
  credentials: OrgCredentials,
): credentials is OrgCredentials & { apiKey: string } {
  return Boolean(
    credentials.apiKey &&
      (credentials.tokenExpiresAt === undefined ||
        Date.now() < credentials.tokenExpiresAt),
  );
}

async function refreshListenerAccessToken(
  credentials: OrgCredentials,
  slot: CredentialSlot,
  deviceId: string,
  connectionName: string,
): Promise<string> {
  if (!credentials.refreshToken) {
    throw new MissingListenerApiKeyError();
  }

  const now = Date.now();
  debugLog("Listen", "Access token expired, refreshing...");

  const tokens = await refreshAccessTokenSingleFlight(
    credentials.refreshToken,
    deviceId,
    connectionName,
    getListenerOAuthDeps().refreshAccessToken,
  );

  await slot.write({
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token ?? credentials.refreshToken,
    tokenExpiresAt: now + tokens.expires_in * 1000,
  });

  debugLog("Listen", "Token refreshed successfully.");
  return tokens.access_token;
}

async function runListenerOAuthLogin(
  slot: CredentialSlot,
  deviceId: string,
  connectionName: string,
  organizationId?: string,
): Promise<string> {
  const oauthDeps = getListenerOAuthDeps();
  console.log("No API key found. Starting OAuth login...\n");

  const deviceData = await oauthDeps.requestDeviceCode(organizationId);
  console.log("Opening your browser to sign in...");
  console.log(
    `If it didn't open, visit: ${deviceData.verification_uri_complete}`,
  );
  console.log(`Your code: ${deviceData.user_code}\n`);
  console.log("Waiting for authorization...\n");
  oauthDeps.openInBrowser(deviceData.verification_uri_complete);

  const tokens = await oauthDeps.pollForToken(
    deviceData.device_code,
    deviceData.interval,
    deviceData.expires_in,
    deviceId,
    connectionName,
  );
  const now = Date.now();

  await slot.write({
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    tokenExpiresAt: now + tokens.expires_in * 1000,
  });

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

  // An organization listener signs in on its own; ambient keys and the
  // global sign-in belong to whichever organization the user picked there.
  if (options.organizationId) {
    if (!isCloudListenerServerUrl(serverUrl)) {
      throw new Error("--org is only supported with Letta Cloud");
    }
    const slot = orgCredentialSlot(options.organizationId);
    const apiKey = await resolveCloudCredentials(
      slot,
      deviceId,
      connectionName,
      allowInteractiveOAuth,
      options.organizationId,
    );
    // Turns, memfs, and subagents in this process read the organization
    // sign-in from here, so they act as the organization the computer joined.
    const credentials = await slot.read();
    activateOrgCredentials(options.organizationId, deviceId, {
      ...credentials,
      apiKey,
    });
    return { serverUrl, apiKey };
  }

  const envApiKey = getDesktopAccessToken() || process.env.LETTA_API_KEY;

  if (envApiKey) {
    return { serverUrl, apiKey: envApiKey };
  }

  if (!isCloudListenerServerUrl(serverUrl)) {
    const apiKey = settings.env?.LETTA_API_KEY;
    if (!apiKey) {
      throw new MissingListenerApiKeyError();
    }
    return { serverUrl, apiKey };
  }

  return {
    serverUrl,
    apiKey: await resolveCloudCredentials(
      globalCredentialSlot(settings),
      deviceId,
      connectionName,
      allowInteractiveOAuth,
    ),
  };
}

async function resolveCloudCredentials(
  slot: CredentialSlot,
  deviceId: string,
  connectionName: string,
  allowInteractiveOAuth: boolean,
  organizationId?: string,
): Promise<string> {
  const credentials = await slot.read();
  let apiKey = credentials.apiKey;

  if (shouldRefreshListenerAccessToken(credentials)) {
    try {
      apiKey = await refreshListenerAccessToken(
        credentials,
        slot,
        deviceId,
        connectionName,
      );
    } catch (refreshError) {
      const retryable =
        !(refreshError instanceof OAuthRefreshError) || refreshError.retryable;
      if (retryable && isAccessTokenStillValid(credentials)) {
        console.warn(
          `Token refresh failed; using the current access token: ${errorMessage(refreshError)}`,
        );
        return credentials.apiKey;
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
    apiKey = await runListenerOAuthLogin(
      slot,
      deviceId,
      connectionName,
      organizationId,
    );
  }

  return apiKey;
}

export async function resolveListenerRegistrationOptions(
  deviceId: string,
  connectionName: string,
  options: ListenerRegistrationOptions = {},
): Promise<RegisterOptions> {
  // Consume the startup transport variable before the first await so no
  // authentication hook or concurrently-spawned descendant can inherit it.
  // Re-registration reads the same process-local cache.
  const spawnerListenerInstanceId = getSpawnerListenerInstanceId();
  const auth = await resolveListenerAuth(deviceId, connectionName, options);
  return {
    ...auth,
    deviceId,
    connectionName,
    // A spawner-assigned identity (Desktop slots, LET-10085) wins; manual
    // listeners keep their legacy name-derived identity unchanged.
    listenerInstanceId:
      spawnerListenerInstanceId ??
      deriveListenerInstanceId(options.surface ?? "server", connectionName),
  };
}

export async function resolveListenerReconnectAuth(
  options: Pick<
    StartListenerOptions,
    "deviceId" | "connectionName" | "organizationId"
  >,
): Promise<{ kind: "ready"; apiKey: string } | { kind: "retry" }> {
  try {
    const auth = await resolveListenerAuth(
      options.deviceId,
      options.connectionName,
      { allowInteractiveOAuth: false, organizationId: options.organizationId },
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
