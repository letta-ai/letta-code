import { hostname } from "node:os";
import {
  LETTA_CLOUD_API_URL,
  refreshAccessToken as refreshLettaAccessToken,
  type TokenResponse,
} from "@/auth/oauth";
import { getLettaCodeHeaders } from "@/backend/api/http-headers";
import {
  getLocalOAuthApiKey,
  getLocalProviderRecordByName,
  LOCAL_CHATGPT_PROVIDER_NAME,
  type LocalProviderRecord,
} from "@/backend/local/local-provider-auth-store";
import { type Settings, settingsManager } from "@/settings-manager";

/**
 * Shared request plumbing for ChatGPT OAuth provider services (usage and
 * rate-limit reset credits). Both services talk to the same two upstreams:
 * ChatGPT directly with a locally stored OAuth token, or Letta Cloud with the
 * user's Letta credential. Keeping auth resolution here means token refresh
 * and settings writes are fixed in one place.
 */

export const OPENAI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";
export const CHATGPT_PROVIDER_CACHE_TTL_MS = 30_000;
export const CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export type ChatGPTUsageErrorCode =
  | "bad_request"
  | "not_connected"
  | "unsupported_target"
  | "refresh_failed"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "network_error"
  | "bad_response";

export interface ChatGPTUsageError {
  code: ChatGPTUsageErrorCode;
  message: string;
  retryAfterMs?: number;
}

export type ChatGPTProviderFailure = {
  success: false;
  error: ChatGPTUsageError;
};

export type CloudCredentialSettings = Pick<
  Settings,
  "env" | "refreshToken" | "tokenExpiresAt"
>;

export type RefreshLettaAccessToken = (
  refreshToken: string,
  deviceId: string,
  deviceName?: string,
) => Promise<TokenResponse>;

export type JsonRecord = Record<string, unknown>;

type MaybeJsonRecord = JsonRecord | null | undefined;

export function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function getValue(record: MaybeJsonRecord, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

export function getNumber(
  record: MaybeJsonRecord,
  keys: string[],
): number | null {
  const value = getValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function getString(
  record: MaybeJsonRecord,
  keys: string[],
): string | null {
  const value = getValue(record, keys);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

export function chatGPTProviderError(
  code: ChatGPTUsageErrorCode,
  message: string,
  retryAfter?: number,
): ChatGPTProviderFailure {
  return {
    success: false,
    error: {
      code,
      message,
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    },
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

export function retryAfterMsFromBody(raw: MaybeJsonRecord): number | undefined {
  const value = getNumber(raw, ["retryAfterMs", "retry_after_ms"]);
  return value === null ? undefined : Math.max(0, value);
}

export async function readJsonRecord(
  response: Response,
): Promise<JsonRecord | null> {
  try {
    return asRecord(await response.json()) ?? null;
  } catch {
    return null;
  }
}

export function responseMessage(
  raw: MaybeJsonRecord,
  fallback: string,
): string {
  return getString(raw, ["message", "error", "detail"]) ?? fallback;
}

// ── Letta Cloud credentials ─────────────────────────────────────────

export async function readCloudCredentialSettings(
  getSettings?: () => Promise<CloudCredentialSettings>,
): Promise<
  { success: true; settings: CloudCredentialSettings } | ChatGPTProviderFailure
> {
  try {
    const settings = await (
      getSettings ?? (() => settingsManager.getSettingsWithSecureTokens())
    )();
    return { success: true, settings };
  } catch (error) {
    return chatGPTProviderError(
      "unauthorized",
      errorMessage(error, "Failed to read Letta Cloud credentials."),
    );
  }
}

export function cloudBaseUrl(settings: Pick<Settings, "env">): string {
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  ).replace(/\/+$/, "");
}

/**
 * Returns a usable Letta Cloud API key, refreshing the OAuth access token and
 * persisting the rotated credentials when it is missing or about to expire.
 * An explicit LETTA_API_KEY environment variable always wins and is never
 * refreshed.
 */
export async function resolveCloudApiKey(input: {
  settings: CloudCredentialSettings;
  now: number;
  /** Feature-specific copy shown when no Letta credential is available. */
  unauthorizedMessage: string;
  refreshAccessToken?: RefreshLettaAccessToken;
}): Promise<{ success: true; apiKey: string } | ChatGPTProviderFailure> {
  const { settings } = input;
  const envApiKey = process.env.LETTA_API_KEY;
  let apiKey = envApiKey || settings.env?.LETTA_API_KEY || null;

  if (
    !envApiKey &&
    settings.refreshToken &&
    (!apiKey ||
      (settings.tokenExpiresAt !== undefined &&
        settings.tokenExpiresAt - input.now < TOKEN_REFRESH_BUFFER_MS))
  ) {
    try {
      const refresh = input.refreshAccessToken ?? refreshLettaAccessToken;
      const tokens = await refresh(
        settings.refreshToken,
        settingsManager.getOrCreateDeviceId(),
        hostname(),
      );
      apiKey = tokens.access_token;
      settingsManager.updateSettings({
        env: { LETTA_API_KEY: tokens.access_token },
        refreshToken: tokens.refresh_token || settings.refreshToken,
        tokenExpiresAt: input.now + tokens.expires_in * 1000,
      });
    } catch (error) {
      // OAuthRefreshError messages name the auth host and OAuth error code,
      // never the token, so they are safe to surface to listener clients.
      return chatGPTProviderError(
        "refresh_failed",
        errorMessage(error, "Failed to refresh the Letta Cloud access token."),
      );
    }
  }

  return apiKey
    ? { success: true, apiKey }
    : chatGPTProviderError("unauthorized", input.unauthorizedMessage);
}

export function cloudRequestHeaders(apiKey: string): Record<string, string> {
  return { ...getLettaCodeHeaders(apiKey), Accept: "application/json" };
}

// ── Local ChatGPT OAuth ─────────────────────────────────────────────

export type LocalChatGPTOAuthRecord = LocalProviderRecord & {
  auth: { type: "oauth"; accountId?: string };
};

function isConnectedChatGPTOAuthRecord(
  record: LocalProviderRecord | null,
): record is LocalChatGPTOAuthRecord {
  return (
    !!record &&
    record.auth.type === "oauth" &&
    (record.provider_type === "chatgpt_oauth" ||
      record.provider_type === OPENAI_CODEX_OAUTH_PROVIDER_ID)
  );
}

/**
 * Finds the connected local ChatGPT OAuth provider. Without an explicit name,
 * checks the default ChatGPT provider name and then the legacy openai-codex id.
 */
export function findLocalChatGPTOAuthRecord(
  providerName: string | undefined,
  storageDir: string | undefined,
): LocalChatGPTOAuthRecord | undefined {
  const names = providerName?.trim()
    ? [providerName.trim()]
    : [LOCAL_CHATGPT_PROVIDER_NAME, OPENAI_CODEX_OAUTH_PROVIDER_ID];
  return names
    .map((name) => getLocalProviderRecordByName(name, storageDir))
    .find(isConnectedChatGPTOAuthRecord);
}

/**
 * Builds ChatGPT backend request headers for a local OAuth provider,
 * refreshing the ChatGPT OAuth token first when it has expired.
 */
export async function localChatGPTRequestHeaders(
  record: LocalChatGPTOAuthRecord,
  storageDir: string | undefined,
): Promise<
  { success: true; headers: Record<string, string> } | ChatGPTProviderFailure
> {
  let oauthApiKey: Awaited<ReturnType<typeof getLocalOAuthApiKey>>;
  try {
    oauthApiKey = await getLocalOAuthApiKey({
      providerId: OPENAI_CODEX_OAUTH_PROVIDER_ID,
      providerNames: [record.name],
      storageDir,
    });
  } catch (error) {
    return chatGPTProviderError(
      "refresh_failed",
      errorMessage(error, "Failed to refresh the ChatGPT OAuth token."),
    );
  }

  if (!oauthApiKey) {
    return chatGPTProviderError(
      "not_connected",
      "No local ChatGPT OAuth token is available.",
    );
  }

  const accountId =
    typeof oauthApiKey.credentials.accountId === "string"
      ? oauthApiKey.credentials.accountId
      : typeof record.auth.accountId === "string"
        ? record.auth.accountId
        : undefined;
  return {
    success: true,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${oauthApiKey.apiKey}`,
      "User-Agent": "letta-code",
      ...(accountId ? { "chatgpt-account-id": accountId } : {}),
    },
  };
}
