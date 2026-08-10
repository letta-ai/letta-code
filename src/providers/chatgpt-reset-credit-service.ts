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
import {
  type ChatGPTUsageError,
  type ChatGPTUsageSnapshot,
  type ReadChatGPTUsageInput,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";
import { type Settings, settingsManager } from "@/settings-manager";

const CHATGPT_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CLOUD_RESET_CREDITS_PATH =
  "/v1/providers/chatgpt-rate-limit-reset-credits";
const CLOUD_RESET_CREDITS_CONSUME_PATH =
  "/v1/providers/chatgpt-rate-limit-reset-credits/consume";
const OPENAI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";
const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ChatGPTRateLimitResetCredit {
  id: string;
  resetType: string;
  status: string;
  grantedAt: string;
  expiresAt: string | null;
  title: string | null;
  description: string | null;
}

export interface ChatGPTRateLimitResetCredits {
  providerName: string;
  fetchedAt: string;
  availableCount: number;
  credits: ChatGPTRateLimitResetCredit[];
}

export type ChatGPTRateLimitResetConsumeOutcome =
  | "reset"
  | "nothing_to_reset"
  | "no_credit"
  | "already_redeemed";

export type ChatGPTRateLimitResetCreditsReadResult =
  | { success: true; credits: ChatGPTRateLimitResetCredits }
  | { success: false; error: ChatGPTUsageError };

export type ChatGPTRateLimitResetCreditConsumeResult =
  | {
      success: true;
      outcome: ChatGPTRateLimitResetConsumeOutcome;
      refreshedUsage?: ChatGPTUsageSnapshot;
      refreshedCredits?: ChatGPTRateLimitResetCredits;
      refreshError?: ChatGPTUsageError;
    }
  | { success: false; error: ChatGPTUsageError };

export interface ReadChatGPTRateLimitResetCreditsInput
  extends ReadChatGPTUsageInput {}

export interface ConsumeChatGPTRateLimitResetCreditInput
  extends Omit<ReadChatGPTUsageInput, "forceRefresh"> {
  idempotencyKey: string;
  resetId?: string;
  readUsage?: typeof readChatGPTUsage;
}

type JsonRecord = Record<string, unknown>;

type CachedResetCredits = {
  expiresAt: number;
  result: Extract<ChatGPTRateLimitResetCreditsReadResult, { success: true }>;
};

type RequestContext = {
  target: "local" | "api";
  providerName: string;
  cacheKey: string;
  listUrl: string;
  consumeUrl: string;
  headers: Record<string, string>;
};

const resetCreditsCache = new Map<string, CachedResetCredits>();

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function getValue(
  record: JsonRecord | null | undefined,
  keys: string[],
): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function getString(
  record: JsonRecord | null | undefined,
  keys: string[],
): string | null {
  const value = getValue(record, keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(
  record: JsonRecord | null | undefined,
  keys: string[],
): number | null {
  const value = getValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function resetCreditError(
  code: ChatGPTUsageError["code"],
  message: string,
  retryAfter?: number,
): { success: false; error: ChatGPTUsageError } {
  return {
    success: false,
    error: {
      code,
      message,
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    },
  };
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt)
    ? Math.max(0, retryAt - Date.now())
    : undefined;
}

async function readJsonRecord(response: Response): Promise<JsonRecord | null> {
  try {
    return asRecord(await response.json());
  } catch {
    return null;
  }
}

function responseMessage(raw: JsonRecord | null, fallback: string): string {
  return getString(raw, ["message", "error", "detail"]) ?? fallback;
}

function cloudBaseUrl(settings: Pick<Settings, "env">): string {
  return (
    process.env.LETTA_BASE_URL ||
    settings.env?.LETTA_BASE_URL ||
    LETTA_CLOUD_API_URL
  ).replace(/\/+$/, "");
}

async function cloudApiKey(input: {
  settings: Pick<Settings, "env" | "refreshToken" | "tokenExpiresAt">;
  now: number;
  refreshAccessToken?: (
    refreshToken: string,
    deviceId: string,
    deviceName?: string,
  ) => Promise<TokenResponse>;
}): Promise<{ apiKey: string | null; error?: ChatGPTUsageError }> {
  const envApiKey = process.env.LETTA_API_KEY;
  let apiKey = envApiKey || input.settings.env?.LETTA_API_KEY || null;

  if (
    !envApiKey &&
    input.settings.refreshToken &&
    (!apiKey ||
      (input.settings.tokenExpiresAt !== undefined &&
        input.settings.tokenExpiresAt - input.now < TOKEN_REFRESH_BUFFER_MS))
  ) {
    try {
      const refresh = input.refreshAccessToken ?? refreshLettaAccessToken;
      const tokens = await refresh(
        input.settings.refreshToken,
        settingsManager.getOrCreateDeviceId(),
        hostname(),
      );
      apiKey = tokens.access_token;
      settingsManager.updateSettings({
        env: { LETTA_API_KEY: tokens.access_token },
        refreshToken: tokens.refresh_token || input.settings.refreshToken,
        tokenExpiresAt: input.now + tokens.expires_in * 1000,
      });
    } catch {
      return {
        apiKey: null,
        error: {
          code: "refresh_failed",
          message: "Failed to refresh the Letta Cloud access token.",
        },
      };
    }
  }

  return apiKey
    ? { apiKey }
    : {
        apiKey: null,
        error: {
          code: "unauthorized",
          message: "Sign in with Letta to read ChatGPT reset credits.",
        },
      };
}

function localProviderNames(providerName: string | undefined): string[] {
  return providerName?.trim()
    ? [providerName.trim()]
    : [LOCAL_CHATGPT_PROVIDER_NAME, OPENAI_CODEX_OAUTH_PROVIDER_ID];
}

function isConnectedChatGPTOAuthRecord(
  record: LocalProviderRecord | null,
): record is LocalProviderRecord & {
  auth: { type: "oauth"; accountId?: string };
} {
  return Boolean(
    record &&
      record.auth.type === "oauth" &&
      (record.provider_type === "chatgpt_oauth" ||
        record.provider_type === OPENAI_CODEX_OAUTH_PROVIDER_ID),
  );
}

async function resolveLocalContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
): Promise<
  | { success: true; context: RequestContext }
  | { success: false; error: ChatGPTUsageError }
> {
  const record = localProviderNames(input.providerName)
    .map((name) => getLocalProviderRecordByName(name, input.storageDir))
    .find(isConnectedChatGPTOAuthRecord);
  if (!record) {
    return resetCreditError(
      "not_connected",
      "No local ChatGPT OAuth provider is connected.",
    );
  }

  let oauthApiKey: Awaited<ReturnType<typeof getLocalOAuthApiKey>>;
  try {
    oauthApiKey = await getLocalOAuthApiKey({
      providerId: OPENAI_CODEX_OAUTH_PROVIDER_ID,
      providerNames: [record.name],
      storageDir: input.storageDir,
    });
  } catch {
    return resetCreditError(
      "refresh_failed",
      "Failed to refresh the ChatGPT OAuth token.",
    );
  }
  if (!oauthApiKey) {
    return resetCreditError(
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
    context: {
      target: "local",
      providerName: record.name,
      cacheKey: `local:${record.name}`,
      listUrl: CHATGPT_RESET_CREDITS_URL,
      consumeUrl: CHATGPT_RESET_CREDITS_CONSUME_URL,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthApiKey.apiKey}`,
        "User-Agent": "letta-code",
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
    },
  };
}

async function resolveApiContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
  now: number,
): Promise<
  | { success: true; context: RequestContext }
  | { success: false; error: ChatGPTUsageError }
> {
  const providerName = input.providerName?.trim();
  if (!providerName) {
    return resetCreditError(
      "bad_request",
      "A ChatGPT provider name is required for cloud reset credits.",
    );
  }

  let settings: Pick<Settings, "env" | "refreshToken" | "tokenExpiresAt">;
  try {
    settings = await (
      input.getSettings ?? (() => settingsManager.getSettingsWithSecureTokens())
    )();
  } catch {
    return resetCreditError(
      "unauthorized",
      "Failed to read Letta Cloud credentials.",
    );
  }

  const baseUrl = cloudBaseUrl(settings);
  const auth = await cloudApiKey({
    settings,
    now,
    refreshAccessToken: input.refreshAccessToken,
  });
  if (auth.error || !auth.apiKey) {
    return {
      success: false,
      error: auth.error ?? {
        code: "unauthorized",
        message: "Sign in with Letta to read ChatGPT reset credits.",
      },
    };
  }

  const listUrl = new URL(`${baseUrl}${CLOUD_RESET_CREDITS_PATH}`);
  listUrl.searchParams.set("provider_name", providerName);
  return {
    success: true,
    context: {
      target: "api",
      providerName,
      cacheKey: `api:${baseUrl}:${providerName}`,
      listUrl: listUrl.toString(),
      consumeUrl: `${baseUrl}${CLOUD_RESET_CREDITS_CONSUME_PATH}`,
      headers: {
        ...getLettaCodeHeaders(auth.apiKey),
        Accept: "application/json",
      },
    },
  };
}

async function resolveRequestContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
  now: number,
): Promise<
  | { success: true; context: RequestContext }
  | { success: false; error: ChatGPTUsageError }
> {
  const target = input.target ?? "local";
  if (target === "local") return resolveLocalContext(input);
  if (target === "api") return resolveApiContext(input, now);
  return resetCreditError(
    "unsupported_target",
    "ChatGPT reset credits are only available for local or cloud ChatGPT OAuth providers.",
  );
}

async function requestJson(input: {
  context: RequestContext;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  method: "GET" | "POST";
  url: string;
  body?: JsonRecord;
}): Promise<
  | { success: true; raw: JsonRecord }
  | { success: false; error: ChatGPTUsageError }
> {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: input.method,
      headers: {
        ...input.context.headers,
        ...(input.body ? { "Content-Type": "application/json" } : {}),
      },
      ...(input.body ? { body: JSON.stringify(input.body) } : {}),
      signal: controller.signal,
    });

    if (response.status === 401) {
      return resetCreditError(
        "unauthorized",
        input.context.target === "api"
          ? "Sign in with Letta to read ChatGPT reset credits."
          : "ChatGPT rejected the OAuth token. Reconnect ChatGPT Plus/Pro and try again.",
      );
    }
    if (response.status === 403) {
      return resetCreditError(
        "forbidden",
        "ChatGPT reset credits are not available for this account.",
      );
    }
    if (response.status === 400 && input.context.target === "api") {
      const raw = await readJsonRecord(response);
      return resetCreditError(
        "bad_request",
        responseMessage(raw, "The reset-credit request was invalid."),
      );
    }
    if (response.status === 404 && input.context.target === "api") {
      const raw = await readJsonRecord(response);
      return raw
        ? resetCreditError(
            "not_connected",
            responseMessage(
              raw,
              "No cloud ChatGPT OAuth provider is connected.",
            ),
          )
        : resetCreditError(
            "network_error",
            "Letta Cloud ChatGPT reset-credit endpoint is unavailable.",
          );
    }
    if (response.status === 429) {
      const raw =
        input.context.target === "api" ? await readJsonRecord(response) : null;
      return resetCreditError(
        "rate_limited",
        raw
          ? responseMessage(
              raw,
              "ChatGPT reset credits are rate limited. Try again later.",
            )
          : "ChatGPT reset credits are rate limited. Try again later.",
        getNumber(raw, ["retryAfterMs", "retry_after_ms"]) ??
          retryAfterMs(response),
      );
    }
    if (!response.ok) {
      const raw =
        input.context.target === "api" ? await readJsonRecord(response) : null;
      return resetCreditError(
        "network_error",
        raw
          ? responseMessage(
              raw,
              `Letta Cloud ChatGPT reset-credit request failed with HTTP ${response.status}.`,
            )
          : `ChatGPT reset-credit request failed with HTTP ${response.status}.`,
      );
    }

    const raw = await readJsonRecord(response);
    return raw
      ? { success: true, raw }
      : resetCreditError(
          didTimeOut ? "network_error" : "bad_response",
          didTimeOut
            ? "ChatGPT reset-credit request timed out."
            : "ChatGPT reset-credit request returned invalid JSON.",
        );
  } catch {
    return resetCreditError(
      "network_error",
      didTimeOut
        ? "ChatGPT reset-credit request timed out."
        : "Failed to fetch ChatGPT reset credits.",
    );
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCredit(value: unknown): ChatGPTRateLimitResetCredit | null {
  const raw = asRecord(value);
  const id = getString(raw, ["id"]);
  const resetType = getString(raw, ["reset_type", "resetType"]);
  const status = getString(raw, ["status"]);
  const grantedAt = getString(raw, ["granted_at", "grantedAt"]);
  if (!id || !resetType || !status || !grantedAt) return null;
  return {
    id,
    resetType,
    status,
    grantedAt,
    expiresAt: getString(raw, ["expires_at", "expiresAt"]),
    title: getString(raw, ["title"]),
    description: getString(raw, ["description"]),
  };
}

function normalizeCredits(input: {
  raw: JsonRecord;
  providerName: string;
  now: number;
}): ChatGPTRateLimitResetCredits | null {
  const availableCount = getNumber(input.raw, [
    "available_count",
    "availableCount",
  ]);
  const rawCredits = input.raw.credits;
  if (
    availableCount === null ||
    !Number.isInteger(availableCount) ||
    availableCount < 0 ||
    !Array.isArray(rawCredits)
  ) {
    return null;
  }
  const credits = rawCredits.map(normalizeCredit);
  if (credits.some((credit) => credit === null)) return null;
  return {
    providerName: input.providerName,
    fetchedAt: new Date(input.now).toISOString(),
    availableCount,
    credits: credits as ChatGPTRateLimitResetCredit[],
  };
}

function normalizeOutcome(
  raw: JsonRecord,
): ChatGPTRateLimitResetConsumeOutcome | null {
  const outcome = getString(raw, ["outcome", "code"]);
  if (outcome === "nothingToReset") return "nothing_to_reset";
  if (outcome === "noCredit") return "no_credit";
  if (outcome === "alreadyRedeemed") return "already_redeemed";
  if (
    outcome === "reset" ||
    outcome === "nothing_to_reset" ||
    outcome === "no_credit" ||
    outcome === "already_redeemed"
  ) {
    return outcome;
  }
  return null;
}

export async function readChatGPTRateLimitResetCredits(
  input: ReadChatGPTRateLimitResetCreditsInput = {},
): Promise<ChatGPTRateLimitResetCreditsReadResult> {
  const now = input.now?.() ?? Date.now();
  const resolved = await resolveRequestContext(input, now);
  if (!resolved.success) return resolved;

  const cached = resetCreditsCache.get(resolved.context.cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const response = await requestJson({
    context: resolved.context,
    fetchImpl: input.fetch,
    timeoutMs: input.timeoutMs,
    method: "GET",
    url: resolved.context.listUrl,
  });
  if (!response.success) return response;

  const credits = normalizeCredits({
    raw: response.raw,
    providerName: resolved.context.providerName,
    now,
  });
  if (!credits) {
    return resetCreditError(
      "bad_response",
      "ChatGPT reset credits returned an invalid payload.",
    );
  }
  const result = { success: true as const, credits };
  resetCreditsCache.set(resolved.context.cacheKey, {
    expiresAt: now + CACHE_TTL_MS,
    result,
  });
  return result;
}

async function refreshRateLimitState(
  input: ConsumeChatGPTRateLimitResetCreditInput,
): Promise<{
  refreshedUsage?: ChatGPTUsageSnapshot;
  refreshedCredits?: ChatGPTRateLimitResetCredits;
  refreshError?: ChatGPTUsageError;
}> {
  const refreshInput: ReadChatGPTUsageInput = {
    target: input.target,
    providerName: input.providerName,
    forceRefresh: true,
    storageDir: input.storageDir,
    timeoutMs: input.timeoutMs,
    fetch: input.fetch,
    now: input.now,
    getSettings: input.getSettings,
    refreshAccessToken: input.refreshAccessToken,
  };
  const [usage, credits] = await Promise.all([
    (input.readUsage ?? readChatGPTUsage)(refreshInput),
    readChatGPTRateLimitResetCredits(refreshInput),
  ]);
  const refreshError = !usage.success
    ? usage.error
    : !credits.success
      ? credits.error
      : undefined;
  return {
    ...(usage.success ? { refreshedUsage: usage.usage } : {}),
    ...(credits.success ? { refreshedCredits: credits.credits } : {}),
    ...(refreshError ? { refreshError } : {}),
  };
}

export async function consumeChatGPTRateLimitResetCredit(
  input: ConsumeChatGPTRateLimitResetCreditInput,
): Promise<ChatGPTRateLimitResetCreditConsumeResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const resetId = input.resetId?.trim();
  if (!idempotencyKey) {
    return resetCreditError(
      "bad_request",
      "An idempotency key is required to consume a reset credit.",
    );
  }
  if (input.resetId !== undefined && !resetId) {
    return resetCreditError("bad_request", "Reset ID cannot be empty.");
  }

  const now = input.now?.() ?? Date.now();
  const resolved = await resolveRequestContext(input, now);
  if (!resolved.success) return resolved;

  const body =
    resolved.context.target === "local"
      ? {
          redeem_request_id: idempotencyKey,
          ...(resetId ? { credit_id: resetId } : {}),
        }
      : {
          provider_name: resolved.context.providerName,
          idempotency_key: idempotencyKey,
          ...(resetId ? { reset_id: resetId } : {}),
        };
  const response = await requestJson({
    context: resolved.context,
    fetchImpl: input.fetch,
    timeoutMs: input.timeoutMs,
    method: "POST",
    url: resolved.context.consumeUrl,
    body,
  });
  if (!response.success) return response;

  const outcome = normalizeOutcome(response.raw);
  if (!outcome) {
    return resetCreditError(
      "bad_response",
      "ChatGPT reset-credit consumption returned an invalid payload.",
    );
  }
  if (outcome !== "reset" && outcome !== "already_redeemed") {
    return { success: true, outcome };
  }

  resetCreditsCache.delete(resolved.context.cacheKey);
  return {
    success: true,
    outcome,
    ...(await refreshRateLimitState(input)),
  };
}
