import { hostname } from "node:os";
import Letta from "@letta-ai/letta-client";
import packageJson from "../../package.json";
import { LETTA_CLOUD_API_URL, refreshAccessToken } from "../auth/oauth";
import { settingsManager } from "../settings-manager";
import { isDebugEnabled } from "../utils/debug";
import { createTimingFetch, isTimingsEnabled } from "../utils/timing";

const SDK_DIAGNOSTIC_MAX_LEN = 400;
const SDK_DIAGNOSTIC_MAX_LINES = 4;

type SDKDiagnostic = {
  lines: string[];
};

let lastSDKDiagnostic: SDKDiagnostic | null = null;

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

export async function getClient() {
  const settings = await settingsManager.getSettingsWithSecureTokens();

  let apiKey = process.env.LETTA_API_KEY || settings.env?.LETTA_API_KEY;

  // Check if token is expired and refresh if needed
  if (
    !process.env.LETTA_API_KEY &&
    settings.tokenExpiresAt &&
    settings.refreshToken
  ) {
    const now = Date.now();
    const expiresAt = settings.tokenExpiresAt;

    // Refresh if token expires within 5 minutes
    if (expiresAt - now < 5 * 60 * 1000) {
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
          env: { ...settings.env, LETTA_API_KEY: tokens.access_token },
          refreshToken: tokens.refresh_token || settings.refreshToken,
          tokenExpiresAt: now + tokens.expires_in * 1000,
        });

        apiKey = tokens.access_token;
      } catch (error) {
        console.error("Failed to refresh access token:", error);
        console.error("Please run 'letta login' to re-authenticate");
        process.exit(1);
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
      "Run 'letta setup' to configure authentication or set your LETTA_API_KEY environment variable",
    );
    process.exit(1);
  }

  // Note: ChatGPT OAuth token refresh is handled by the Letta backend
  // when using the chatgpt_oauth provider type

  return new Letta({
    apiKey,
    baseURL,
    logger: sdkLogger,
    defaultHeaders: {
      "X-Letta-Source": "letta-code",
      "User-Agent": `letta-code/${packageJson.version}`,
    },
    // Use instrumented fetch for timing logs when LETTA_DEBUG_TIMINGS is enabled
    ...(isTimingsEnabled() && { fetch: createTimingFetch(fetch) }),
  });
}
