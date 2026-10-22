import {
  asRecord,
  CHATGPT_PROVIDER_CACHE_TTL_MS,
  CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS,
  type ChatGPTProviderFailure,
  type ChatGPTUsageError,
  chatGPTProviderError,
  cloudBaseUrl,
  cloudRequestHeaders,
  findLocalChatGPTOAuthRecord,
  getNumber,
  getString,
  type JsonRecord,
  localChatGPTRequestHeaders,
  readCloudCredentialSettings,
  readJsonRecord,
  resolveCloudApiKey,
  responseMessage,
  retryAfterMs,
  retryAfterMsFromBody,
} from "@/providers/chatgpt-provider-auth";
import {
  type ChatGPTUsageSnapshot,
  type ReadChatGPTUsageInput,
  readChatGPTUsage,
} from "@/providers/chatgpt-usage-service";

const CHATGPT_RESET_CREDITS_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const CHATGPT_RESET_CREDITS_CONSUME_URL =
  "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume";
const CLOUD_RESET_CREDITS_PATH =
  "/v1/providers/chatgpt-rate-limit-reset-credits";
const CLOUD_RESET_CREDITS_CONSUME_PATH =
  "/v1/providers/chatgpt-rate-limit-reset-credits/consume";
const CLOUD_UNAUTHORIZED_MESSAGE =
  "Sign in with Letta to read ChatGPT reset credits.";

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
  | ChatGPTProviderFailure;

export type ChatGPTRateLimitResetCreditConsumeResult =
  | {
      success: true;
      outcome: ChatGPTRateLimitResetConsumeOutcome;
      refreshedUsage?: ChatGPTUsageSnapshot;
      refreshedCredits?: ChatGPTRateLimitResetCredits;
      refreshError?: ChatGPTUsageError;
    }
  | ChatGPTProviderFailure;

export interface ReadChatGPTRateLimitResetCreditsInput
  extends ReadChatGPTUsageInput {}

export interface ConsumeChatGPTRateLimitResetCreditInput
  extends Omit<ReadChatGPTUsageInput, "forceRefresh"> {
  idempotencyKey: string;
  resetId?: string;
  readUsage?: typeof readChatGPTUsage;
}

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

async function resolveLocalContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
): Promise<
  { success: true; context: RequestContext } | ChatGPTProviderFailure
> {
  const record = findLocalChatGPTOAuthRecord(
    input.providerName,
    input.storageDir,
  );
  if (!record) {
    return chatGPTProviderError(
      "not_connected",
      "No local ChatGPT OAuth provider is connected.",
    );
  }

  const localHeaders = await localChatGPTRequestHeaders(
    record,
    input.storageDir,
  );
  if (!localHeaders.success) return localHeaders;

  return {
    success: true,
    context: {
      target: "local",
      providerName: record.name,
      cacheKey: `local:${record.name}`,
      listUrl: CHATGPT_RESET_CREDITS_URL,
      consumeUrl: CHATGPT_RESET_CREDITS_CONSUME_URL,
      headers: localHeaders.headers,
    },
  };
}

async function resolveApiContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
  now: number,
): Promise<
  { success: true; context: RequestContext } | ChatGPTProviderFailure
> {
  const providerName = input.providerName?.trim();
  if (!providerName) {
    return chatGPTProviderError(
      "bad_request",
      "A ChatGPT provider name is required for cloud reset credits.",
    );
  }

  const credentialSettings = await readCloudCredentialSettings(
    input.getSettings,
  );
  if (!credentialSettings.success) return credentialSettings;
  const { settings } = credentialSettings;

  const baseUrl = cloudBaseUrl(settings);
  const auth = await resolveCloudApiKey({
    settings,
    now,
    unauthorizedMessage: CLOUD_UNAUTHORIZED_MESSAGE,
    refreshAccessToken: input.refreshAccessToken,
  });
  if (!auth.success) return auth;

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
      headers: cloudRequestHeaders(auth.apiKey),
    },
  };
}

async function resolveRequestContext(
  input: ReadChatGPTRateLimitResetCreditsInput,
  now: number,
): Promise<
  { success: true; context: RequestContext } | ChatGPTProviderFailure
> {
  const target = input.target ?? "local";
  if (target === "local") return resolveLocalContext(input);
  if (target === "api") return resolveApiContext(input, now);
  return chatGPTProviderError(
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
}): Promise<{ success: true; raw: JsonRecord } | ChatGPTProviderFailure> {
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS);

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
      return chatGPTProviderError(
        "unauthorized",
        input.context.target === "api"
          ? CLOUD_UNAUTHORIZED_MESSAGE
          : "ChatGPT rejected the OAuth token. Reconnect ChatGPT Plus/Pro and try again.",
      );
    }
    if (response.status === 403) {
      return chatGPTProviderError(
        "forbidden",
        "ChatGPT reset credits are not available for this account.",
      );
    }
    if (response.status === 400 && input.context.target === "api") {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        "bad_request",
        responseMessage(raw, "The reset-credit request was invalid."),
      );
    }
    if (response.status === 404 && input.context.target === "api") {
      const raw = await readJsonRecord(response);
      return raw
        ? chatGPTProviderError(
            "not_connected",
            responseMessage(
              raw,
              "No cloud ChatGPT OAuth provider is connected.",
            ),
          )
        : chatGPTProviderError(
            "network_error",
            "Letta Cloud ChatGPT reset-credit endpoint is unavailable.",
          );
    }
    if (response.status === 429) {
      const raw =
        input.context.target === "api" ? await readJsonRecord(response) : null;
      return chatGPTProviderError(
        "rate_limited",
        raw
          ? responseMessage(
              raw,
              "ChatGPT reset credits are rate limited. Try again later.",
            )
          : "ChatGPT reset credits are rate limited. Try again later.",
        retryAfterMsFromBody(raw) ?? retryAfterMs(response),
      );
    }
    if (!response.ok) {
      const raw =
        input.context.target === "api" ? await readJsonRecord(response) : null;
      return chatGPTProviderError(
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
      : chatGPTProviderError(
          didTimeOut ? "network_error" : "bad_response",
          didTimeOut
            ? "ChatGPT reset-credit request timed out."
            : "ChatGPT reset-credit request returned invalid JSON.",
        );
  } catch {
    return chatGPTProviderError(
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
    return chatGPTProviderError(
      "bad_response",
      "ChatGPT reset credits returned an invalid payload.",
    );
  }
  const result = { success: true as const, credits };
  resetCreditsCache.set(resolved.context.cacheKey, {
    expiresAt: now + CHATGPT_PROVIDER_CACHE_TTL_MS,
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
    return chatGPTProviderError(
      "bad_request",
      "An idempotency key is required to consume a reset credit.",
    );
  }
  if (input.resetId !== undefined && !resetId) {
    return chatGPTProviderError("bad_request", "Reset ID cannot be empty.");
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
    return chatGPTProviderError(
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
