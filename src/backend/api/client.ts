import { hostname } from "node:os";
import Letta from "@letta-ai/letta-client";
import {
  bindDesktopCredentials,
  getDesktopAccessToken,
} from "@/auth/desktop-credentials";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { refreshAccessTokenSingleFlight } from "@/auth/oauth-refresh";
import {
  bindOrgCredentials,
  getOrgAccessToken,
} from "@/auth/org-credentials-session";
import { type Settings, settingsManager } from "@/settings-manager";
import { trackBoundaryError } from "@/telemetry/error-reporting";
import { isDebugEnabled } from "@/utils/debug";
import { createTimingFetch, isTimingsEnabled } from "@/utils/timing";
import packageJson from "../../../package.json";

const SDK_DIAGNOSTIC_MAX_LEN = 400;
const SDK_DIAGNOSTIC_MAX_LINES = 4;

type SDKDiagnostic = {
  lines: string[];
};

let lastSDKDiagnostic: SDKDiagnostic | null = null;

let _cachedApiKey: string | undefined;
let _testClientOverride: (() => Promise<unknown>) | null = null;

export function __testOverrideGetClient(
  factory: (() => Promise<unknown>) | null,
): void {
  _testClientOverride = factory;
}

function safeDiagnosticString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncateDiagnostic(value: unknown): string {
  const text = safeDiagnosticString(value);

  if (text.length <= SDK_DIAGNOSTIC_MAX_LEN) {
    return text;
  }

  return `${text.slice(0, SDK_DIAGNOSTIC_MAX_LEN)}...[truncated, was ${text.length}b]`;
}

function captureSDKErrorDiagnostic(args: unknown[]): void {
  const diagnosticLine = truncateDiagnostic(
    args.map((arg) => safeDiagnosticString(arg)).join(" "),
  );

  const previous = lastSDKDiagnostic ?? { lines: [] };

  lastSDKDiagnostic = {
    lines: [...previous.lines, diagnosticLine].slice(-SDK_DIAGNOSTIC_MAX_LINES),
  };
}

export function consumeLastSDKDiagnostic(): string | null {
  const diag = lastSDKDiagnostic;
  lastSDKDiagnostic = null;

  if (!diag || diag.lines.length === 0) {
    return null;
  }

  return `sdk_error=${diag.lines.join(" || ")}`;
}

export function clearLastSDKDiagnostic(): void {
  lastSDKDiagnostic = null;
}

const sdkLogger = {
  error: (...args: unknown[]) => {
    try {
      captureSDKErrorDiagnostic(args);
    } catch {}
    if (isDebugEnabled()) {
      console.error(...args);
    }
  },
  warn: (...args: unknown[]) => {
    console.warn(...args);
  },
  info: (...args: unknown[]) => {
    console.info(...args);
  },
  debug: (...args: unknown[]) => {
    console.debug(...args);
  },
};

export {
  getMemfsGitProxyRewriteConfig,
  getMemfsServerUrl,
  LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV,
  type MemfsGitProxyRewriteConfig,
} from "./memfs-git-proxy";

const RUNTIME_ENVIRONMENT_DEVICE_ID_ENV = "LETTA_RUNTIME_ENVIRONMENT_DEVICE_ID";

export function getRuntimeEnvironmentDeviceId(): string {
  return (
    process.env[RUNTIME_ENVIRONMENT_DEVICE_ID_ENV]?.trim() ||
    settingsManager.getOrCreateDeviceId()
  );
}

export function getClientDefaultHeaders(): Record<string, string> {
  return {
    "X-Letta-Source": "letta-code",
    "User-Agent": `letta-code/${packageJson.version}`,
    "X-Letta-Environment-Device-Id": getRuntimeEnvironmentDeviceId(),
    ...(process.env.LETTA_MEMFS_BACKEND === "hosted"
      ? { "x-letta-memfs-backend": "hosted" }
      : {}),
  };
}

export async function getClient() {
  if (_testClientOverride) {
    return (await _testClientOverride()) as Letta;
  }

  const baseSettings = settingsManager.getSettings();
  const cachedTokens = settingsManager.getCachedSecureTokens();
  const cachedSettings: Settings = {
    ...baseSettings,
    env: {
      ...baseSettings.env,
      ...(cachedTokens.apiKey && { LETTA_API_KEY: cachedTokens.apiKey }),
    },
    refreshToken: cachedTokens.refreshToken ?? baseSettings.refreshToken,
  };
  const settings =
    process.env.LETTA_API_KEY ||
    cachedSettings.env?.LETTA_API_KEY ||
    cachedSettings.refreshToken
      ? cachedSettings
      : await settingsManager.getSettingsWithSecureTokens();

  const orgAccessToken = await getOrgAccessToken();
  const desktopAccessToken = orgAccessToken
    ? undefined
    : getDesktopAccessToken();
  let apiKey =
    orgAccessToken ||
    desktopAccessToken ||
    process.env.LETTA_API_KEY ||
    settings.env?.LETTA_API_KEY;

  if (!orgAccessToken && !process.env.LETTA_API_KEY) {
    if (apiKey) {
      _cachedApiKey = apiKey;
    } else if (_cachedApiKey) {
      apiKey = _cachedApiKey;
    }
  }

  if (
    !orgAccessToken &&
    !desktopAccessToken &&
    !process.env.LETTA_API_KEY &&
    settings.tokenExpiresAt &&
    settings.refreshToken
  ) {
    const now = Date.now();
    const expiresAt = settings.tokenExpiresAt;

    if (!apiKey || expiresAt - now < 5 * 60 * 1000) {
      try {
        const deviceId = settingsManager.getOrCreateDeviceId();
        const deviceName = hostname();

        const tokens = await refreshAccessTokenSingleFlight(
          settings.refreshToken,
          deviceId,
          deviceName,
        );

        settingsManager.updateSettings({
          env: { LETTA_API_KEY: tokens.access_token },
          refreshToken: tokens.refresh_token || settings.refreshToken,
          tokenExpiresAt: now + tokens.expires_in * 1000,
        });

        apiKey = tokens.access_token;
        _cachedApiKey = tokens.access_token;
      } catch (error) {
        trackBoundaryError({
          errorType: "auth_token_refresh_failed",
          error,
          context: "auth_client_token_refresh",
        });
        console.error("Failed to refresh access token:", error);
        console.error(
          "\nIf you experience this issue multiple times, move ~/.letta to ~/.letta_backup, and re-run 'letta' to re-authenticate",
        );
        throw new Error(
          `Failed to refresh access token: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  const baseURL =
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL;

  if (!apiKey && baseURL === LETTA_CLOUD_API_URL) {
    console.error("Missing LETTA_API_KEY");
    console.error(
      "Run 'letta' to configure authentication, or set LETTA_API_KEY to your API key",
    );
    console.error(new Error("getClient() called without credentials").stack);
    throw new Error(
      "Missing LETTA_API_KEY. Run 'letta' to configure authentication, or set LETTA_API_KEY to your API key.",
    );
  }

  const client = new Letta({
    apiKey,
    baseURL,
    logger: sdkLogger,
    timeout: Number(process.env.LETTA_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000,
    defaultHeaders: getClientDefaultHeaders(),
    ...(isTimingsEnabled() && { fetch: createTimingFetch(fetch) }),
  });

  const MESSAGE_CACHE_MAX = 32;
  const messageCache = new Map<string, Promise<unknown>>();
  const origRetrieveMessage = client.messages.retrieve.bind(client.messages);
  client.messages.retrieve = ((
    ...args: Parameters<typeof client.messages.retrieve>
  ) => {
    const messageId = args[0] as string;
    const cached = messageCache.get(messageId);
    if (cached) {
      messageCache.delete(messageId);
      messageCache.set(messageId, cached);
      return cached;
    }
    const promise = origRetrieveMessage(...args);
    messageCache.set(messageId, promise);
    if (messageCache.size > MESSAGE_CACHE_MAX) {
      const oldest = messageCache.keys().next().value;
      if (oldest !== undefined) messageCache.delete(oldest);
    }
    promise.catch(() => messageCache.delete(messageId));
    return promise;
  }) as typeof client.messages.retrieve;

  if (orgAccessToken) return bindOrgCredentials(client);
  return bindDesktopCredentials(client);
}
