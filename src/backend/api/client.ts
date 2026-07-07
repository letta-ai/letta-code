import { hostname } from "node:os";
import Letta from "@letta-ai/letta-client";
import { LETTA_CLOUD_API_URL, refreshAccessToken } from "@/auth/oauth";
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

// In-process cache of the last successfully obtained API key (not from a
// static env var). Populated on first successful keychain read and updated
// whenever the OAuth refresh obtains a new token. Used as a fallback so
// transient keychain failures don't crash the process mid-session.
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
    } catch {
      // Diagnostic capture must never disrupt the SDK
    }
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

/**
 * Get the current Letta server URL from environment or settings.
 * Used for cache keys and API operations.
 */
export function getServerUrl(): string {
  const settings = settingsManager.getSettings();
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  );
}

export {
  getMemfsGitProxyRewriteConfig,
  getMemfsServerUrl,
  LETTA_MEMFS_GIT_PROXY_BASE_URL_ENV,
  type MemfsGitProxyRewriteConfig,
} from "./memfs-git-proxy";

const NODE_HEADER_ENABLED_VALUES = new Set(["1", "true", "yes"]);

/**
 * Resolve the `x-letta-node` runtime routing header from the LETTA_NODE env
 * var only. The old "node" experiment is retired: persisted
 * `experiments.node` settings overrides are ignored so a stale opt-out can no
 * longer silently pin an installation's traffic to the Python core runtime
 * (LET-9516). When LETTA_NODE is unset, no header is sent and the server
 * routes letta-code traffic to the TS runtime by default.
 */
function getNodeRoutingHeader(): Record<string, string> {
  const raw = process.env.LETTA_NODE;
  if (raw === undefined || raw.trim() === "") {
    return {};
  }
  const enabled = NODE_HEADER_ENABLED_VALUES.has(raw.trim().toLowerCase());
  return { "x-letta-node": enabled ? "1" : "0" };
}

export function getClientDefaultHeaders(): Record<string, string> {
  return {
    "X-Letta-Source": "letta-code",
    "User-Agent": `letta-code/${packageJson.version}`,
    // Identify this device on user-message turns so the cloud can
    // persist the (agent, conversation) → device association and
    // restore it on other browsers/sessions. The cloud middleware
    // ignores this header on non-message routes.
    "X-Letta-Environment-Device-Id": settingsManager.getOrCreateDeviceId(),
    ...getNodeRoutingHeader(),
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

  let apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  if (!process.env.LETTA_API_KEY) {
    if (apiKey) {
      // Keep the in-process cache current on every successful keychain read.
      _cachedApiKey = apiKey;
    } else if (_cachedApiKey) {
      // Keychain returned null (e.g. delete-then-set race during token
      // rotation, or a transient keychain failure). Fall back to the last
      // key we successfully obtained so the process doesn't crash mid-session.
      apiKey = _cachedApiKey;
    }
  }

  // Check if token is expired and refresh if needed
  if (
    !process.env.LETTA_API_KEY &&
    settings.tokenExpiresAt &&
    settings.refreshToken
  ) {
    const now = Date.now();
    const expiresAt = settings.tokenExpiresAt;

    // Refresh if token expires within 5 minutes, or if the access token is
    // missing entirely (e.g. transient keychain read failure during the
    // delete-then-set window of a concurrent refresh).
    if (!apiKey || expiresAt - now < 5 * 60 * 1000) {
      try {
        // Get or generate device ID (should always exist, but fallback just in case)
        const deviceId = settingsManager.getOrCreateDeviceId();
        const deviceName = hostname();

        const tokens = await refreshAccessToken(
          settings.refreshToken,
          deviceId,
          deviceName,
        );

        // Update settings with new token (secrets handles secure storage automatically)
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

  // Check if refresh token is missing for Letta Cloud
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

  // Note: ChatGPT OAuth token refresh is handled by the Letta backend
  // when using the chatgpt_oauth provider type
  const client = new Letta({
    apiKey,
    baseURL,
    logger: sdkLogger,
    timeout: Number(process.env.LETTA_REQUEST_TIMEOUT_MS) || 10 * 60 * 1000, // default 10 min; override via env for slow local inference
    defaultHeaders: getClientDefaultHeaders(),
    // Use instrumented fetch for timing logs when LETTA_DEBUG_TIMINGS is enabled
    ...(isTimingsEnabled() && { fetch: createTimingFetch(fetch) }),
  });

  // ── Immutable-resource cache ──
  // messages.retrieve returns immutable data (messages don't change after
  // creation), so we cache results to avoid redundant round-trips.
  // Capped at 32 entries with LRU eviction.
  const MESSAGE_CACHE_MAX = 32;
  const messageCache = new Map<string, Promise<unknown>>();
  const origRetrieveMessage = client.messages.retrieve.bind(client.messages);
  client.messages.retrieve = ((
    ...args: Parameters<typeof client.messages.retrieve>
  ) => {
    const messageId = args[0] as string;
    const cached = messageCache.get(messageId);
    if (cached) {
      // Move to end (most recent) for LRU ordering.
      messageCache.delete(messageId);
      messageCache.set(messageId, cached);
      return cached;
    }
    const promise = origRetrieveMessage(...args);
    messageCache.set(messageId, promise);
    // Evict oldest entry when over capacity.
    if (messageCache.size > MESSAGE_CACHE_MAX) {
      const oldest = messageCache.keys().next().value;
      if (oldest !== undefined) messageCache.delete(oldest);
    }
    // Evict on failure so transient errors don't stick.
    promise.catch(() => messageCache.delete(messageId));
    return promise;
  }) as typeof client.messages.retrieve;

  return client;
}
