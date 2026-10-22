import type { TokenResponse } from "@/auth/oauth";
import type { ProviderStorageTarget } from "@/providers/byok-providers";
import {
  asRecord,
  CHATGPT_PROVIDER_CACHE_TTL_MS,
  CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS,
  type ChatGPTUsageError,
  type CloudCredentialSettings,
  chatGPTProviderError,
  cloudBaseUrl,
  cloudRequestHeaders,
  findLocalChatGPTOAuthRecord,
  getNumber,
  getString,
  getValue,
  type JsonRecord,
  localChatGPTRequestHeaders,
  readCloudCredentialSettings,
  readJsonRecord,
  resolveCloudApiKey,
  responseMessage,
  retryAfterMs,
  retryAfterMsFromBody,
} from "@/providers/chatgpt-provider-auth";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLOUD_CHATGPT_USAGE_PATH = "/v1/providers/chatgpt-usage";

export interface ChatGPTUsageWindow {
  label: string;
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface ChatGPTUsageCredits {
  balance?: string | null;
  availableCount?: number | null;
  hasCredits?: boolean | null;
  unlimited?: boolean | null;
}

export interface ChatGPTUsageIndividualLimit {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number;
}

export interface ChatGPTUsageSnapshot {
  providerName: string;
  fetchedAt: string;
  summary: string;
  planType?: string | null;
  limitReached?: boolean | null;
  rateLimitReachedType?: string | null;
  primary: ChatGPTUsageWindow | null;
  secondary: ChatGPTUsageWindow | null;
  additional: ChatGPTUsageWindow[];
  credits?: ChatGPTUsageCredits | null;
  individualLimit?: ChatGPTUsageIndividualLimit | null;
}

export type ChatGPTUsageReadResult =
  | { success: true; usage: ChatGPTUsageSnapshot }
  | { success: false; error: ChatGPTUsageError };

export interface ReadChatGPTUsageInput {
  target?: ProviderStorageTarget;
  providerName?: string;
  forceRefresh?: boolean;
  storageDir?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  getSettings?: () => Promise<CloudCredentialSettings>;
  refreshAccessToken?: (
    refreshToken: string,
    deviceId: string,
    deviceName?: string,
  ) => Promise<TokenResponse>;
}

type CachedUsage = {
  expiresAt: number;
  result: Extract<ChatGPTUsageReadResult, { success: true }>;
};

const usageCache = new Map<string, CachedUsage>();

function getRecord(
  record: JsonRecord | undefined,
  keys: string[],
): JsonRecord | undefined {
  return asRecord(getValue(record, keys));
}

function getRecordArray(
  record: JsonRecord | undefined,
  keys: string[],
): JsonRecord[] {
  const value = getValue(record, keys);
  if (!Array.isArray(value)) return [];
  return value.map(asRecord).filter((item): item is JsonRecord => !!item);
}

function getBoolean(
  record: JsonRecord | undefined,
  keys: string[],
): boolean | null {
  const value = getValue(record, keys);
  return typeof value === "boolean" ? value : null;
}

function normalizeTimestampSeconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestampSeconds(numeric);

    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

function getTimestampSeconds(
  record: JsonRecord | undefined,
  keys: string[],
): number | null {
  return normalizeTimestampSeconds(getValue(record, keys));
}

function normalizeUsageWindow(
  value: unknown,
  label: string,
  nowMs: number,
): ChatGPTUsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;

  const usedPercent = getNumber(record, [
    "used_percent",
    "usedPercent",
    "used_percentage",
    "usedPercentage",
    "percent_used",
    "percentUsed",
  ]);
  const limitWindowSeconds = getNumber(record, [
    "limit_window_seconds",
    "limitWindowSeconds",
  ]);
  const windowDurationMins =
    getNumber(record, [
      "window_duration_minutes",
      "windowDurationMinutes",
      "window_duration_mins",
      "windowDurationMins",
      "window_minutes",
      "windowMinutes",
    ]) ?? (limitWindowSeconds === null ? null : limitWindowSeconds / 60);

  const resetAfterSeconds = getNumber(record, [
    "reset_after_seconds",
    "resetAfterSeconds",
  ]);
  const resetsAt =
    getTimestampSeconds(record, [
      "reset_at",
      "resetAt",
      "resets_at",
      "resetsAt",
    ]) ??
    (resetAfterSeconds === null
      ? null
      : Math.floor(nowMs / 1000 + resetAfterSeconds));

  if (
    usedPercent === null &&
    windowDurationMins === null &&
    resetsAt === null
  ) {
    return null;
  }

  return {
    label,
    usedPercent,
    windowDurationMins,
    resetsAt,
  };
}

function normalizeCredits(
  raw: JsonRecord | undefined,
  rateLimit: JsonRecord | undefined,
): ChatGPTUsageCredits | null {
  const credits =
    getRecord(raw, ["credits", "credit_balance", "creditBalance"]) ??
    getRecord(rateLimit, [
      "credits",
      "credit_balance",
      "creditBalance",
      "reset_credits",
      "resetCredits",
      "rate_limit_reset_credits",
      "rateLimitResetCredits",
    ]);
  const resetCredits =
    getRecord(raw, ["rate_limit_reset_credits", "rateLimitResetCredits"]) ??
    getRecord(rateLimit, ["rate_limit_reset_credits", "rateLimitResetCredits"]);
  if (!credits && !resetCredits) return null;

  const balance = getString(credits, ["balance", "credit_balance", "amount"]);
  const availableCount =
    getNumber(credits, ["available_count", "availableCount", "count"]) ??
    getNumber(resetCredits, ["available_count", "availableCount", "count"]);
  const hasCredits = getBoolean(credits, ["has_credits", "hasCredits"]);
  const unlimited = getBoolean(credits, ["unlimited", "is_unlimited"]);

  if (
    balance === null &&
    availableCount === null &&
    hasCredits === null &&
    unlimited === null
  ) {
    return null;
  }

  return {
    ...(balance !== null ? { balance } : {}),
    ...(availableCount !== null ? { availableCount } : {}),
    ...(hasCredits !== null ? { hasCredits } : {}),
    ...(unlimited !== null ? { unlimited } : {}),
  };
}

function normalizeIndividualLimit(
  raw: JsonRecord | undefined,
  nowMs: number,
): ChatGPTUsageIndividualLimit | null {
  const spendControl = getRecord(raw, ["spend_control", "spendControl"]);
  const record =
    getRecord(raw, ["individual_limit", "individualLimit"]) ??
    getRecord(spendControl, ["individual_limit", "individualLimit"]);
  if (!record) return null;

  const limit = getString(record, ["limit"]);
  const used = getString(record, ["used"]);
  const remainingPercent = getNumber(record, [
    "remaining_percent",
    "remainingPercent",
  ]);
  const resetAfterSeconds = getNumber(record, [
    "reset_after_seconds",
    "resetAfterSeconds",
  ]);
  const resetsAt =
    getTimestampSeconds(record, [
      "reset_at",
      "resetAt",
      "resets_at",
      "resetsAt",
    ]) ??
    (resetAfterSeconds === null
      ? null
      : Math.floor(nowMs / 1000 + resetAfterSeconds));

  if (
    limit === null ||
    used === null ||
    remainingPercent === null ||
    resetsAt === null
  ) {
    return null;
  }

  return {
    limit,
    used,
    remainingPercent,
    resetsAt,
  };
}

function normalizeCloudUsageWindow(
  value: unknown,
  fallbackLabel: string,
  nowMs: number,
): ChatGPTUsageWindow | null {
  const record = asRecord(value);
  if (!record) return null;
  return normalizeUsageWindow(
    record,
    getString(record, ["label", "name"]) ?? fallbackLabel,
    nowMs,
  );
}

function normalizeAdditionalRateLimit(
  details: JsonRecord,
  index: number,
  nowMs: number,
): ChatGPTUsageWindow[] {
  const label =
    getString(details, [
      "limit_name",
      "limitName",
      "metered_feature",
      "meteredFeature",
      "label",
      "name",
      "model",
      "limit_id",
      "limitId",
    ]) ?? `limit ${index + 1}`;
  const nestedRateLimit = getRecord(details, ["rate_limit", "rateLimit"]);
  const source = nestedRateLimit ?? details;
  const primary = normalizeUsageWindow(
    getValue(source, ["primary_window", "primaryWindow", "primary"]),
    label,
    nowMs,
  );
  const secondary = normalizeUsageWindow(
    getValue(source, ["secondary_window", "secondaryWindow", "secondary"]),
    `${label} secondary`,
    nowMs,
  );
  const direct = nestedRateLimit
    ? null
    : normalizeUsageWindow(details, label, nowMs);

  return [primary, secondary, direct].filter(
    (window): window is ChatGPTUsageWindow => !!window,
  );
}

function getRateLimitReachedType(raw: JsonRecord | undefined): string | null {
  const value = getValue(raw, [
    "rate_limit_reached_type",
    "rateLimitReachedType",
  ]);
  if (typeof value === "string" && value.trim()) return value.trim();

  const record = asRecord(value);
  return getString(record, ["type", "kind"]);
}

function formatPercent(value: number): string {
  const rounded = Math.round(value);
  return Number.isInteger(value) || Math.abs(value - rounded) < 0.05
    ? String(rounded)
    : value.toFixed(1);
}

function formatDuration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes <= 0) {
    return null;
  }
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${Math.round(minutes)}m`;
}

function formatResetDistance(
  resetsAt: number | null,
  now: Date,
): string | null {
  if (resetsAt === null) return null;
  const deltaMs = resetsAt * 1000 - now.getTime();
  if (deltaMs <= 0) return "now";

  const minutes = Math.ceil(deltaMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;

  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `in ${hours}h`;

  return `in ${Math.ceil(hours / 24)}d`;
}

function formatWindowLabel(window: ChatGPTUsageWindow): string {
  const duration = formatDuration(window.windowDurationMins);
  if (duration) return duration;
  return window.label;
}

function formatNamedWindowLabel(window: ChatGPTUsageWindow): string {
  const normalizedLabel = window.label.replace(/_/g, " ").trim();
  const duration = formatDuration(window.windowDurationMins);
  return duration ? `${normalizedLabel} ${duration}` : normalizedLabel;
}

function formatUsageWindow(
  window: ChatGPTUsageWindow | null,
  now: Date,
  options: { includeName?: boolean } = {},
): string | null {
  if (!window) return null;

  const label = options.includeName
    ? formatNamedWindowLabel(window)
    : formatWindowLabel(window);
  const parts: string[] = [label];
  if (window.usedPercent !== null) {
    const remaining = Math.max(0, 100 - window.usedPercent);
    parts.push(`${formatPercent(remaining)}% left`);
  }

  const resetDistance = formatResetDistance(window.resetsAt, now);
  if (resetDistance) parts.push(`resets ${resetDistance}`);

  return parts.join(" ");
}

function formatCredits(
  credits: ChatGPTUsageCredits | null | undefined,
): string | null {
  if (!credits) return null;
  if (credits.unlimited) return "credits unlimited";
  if (typeof credits.availableCount === "number") {
    return `credits ${formatPercent(credits.availableCount)}`;
  }
  if (credits.balance) return `credits ${credits.balance}`;
  if (credits.hasCredits !== null && credits.hasCredits !== undefined) {
    return credits.hasCredits ? "credits available" : "no credits";
  }
  return null;
}

export function formatChatGPTUsageSnapshot(
  snapshot: Omit<ChatGPTUsageSnapshot, "summary">,
  now: Date = new Date(),
): string {
  const windows = [
    formatUsageWindow(snapshot.primary, now),
    formatUsageWindow(snapshot.secondary, now),
    ...snapshot.additional.map((window) =>
      formatUsageWindow(window, now, { includeName: true }),
    ),
  ].filter((item): item is string => !!item);

  const credits = formatCredits(snapshot.credits);
  if (credits) windows.push(credits);

  if (windows.length === 0) {
    return "Usage: no active quota window reported";
  }
  return `Usage: ${windows.join(" · ")}`;
}

export function formatChatGPTUsageQuotaRows(
  snapshot: ChatGPTUsageSnapshot,
  now: Date = new Date(),
): string[] {
  const rows = [
    formatUsageWindow(snapshot.primary, now),
    formatUsageWindow(snapshot.secondary, now),
  ].filter((item): item is string => !!item);

  return rows.length > 0 ? rows : [snapshot.summary.replace(/^Usage:\s*/, "")];
}

export function normalizeWhamUsageResponse(input: {
  raw: unknown;
  providerName: string;
  nowMs?: number;
}): ChatGPTUsageSnapshot {
  const raw = asRecord(input.raw);
  const nowMs = input.nowMs ?? Date.now();
  const fetchedAt = new Date(nowMs).toISOString();
  const rateLimit =
    getRecord(raw, ["rate_limit", "rateLimit", "rate_limits", "rateLimits"]) ??
    raw;
  const primary = normalizeUsageWindow(
    getValue(rateLimit, ["primary_window", "primaryWindow", "primary"]),
    "primary",
    nowMs,
  );
  const secondary = normalizeUsageWindow(
    getValue(rateLimit, ["secondary_window", "secondaryWindow", "secondary"]),
    "secondary",
    nowMs,
  );
  const additionalSources = [
    ...getRecordArray(raw, [
      "additional_rate_limits",
      "additionalRateLimits",
      "additional",
    ]),
    ...(raw === rateLimit
      ? []
      : getRecordArray(rateLimit, [
          "additional_rate_limits",
          "additionalRateLimits",
          "additional",
        ])),
  ];
  const additional = additionalSources.flatMap((details, index) =>
    normalizeAdditionalRateLimit(details, index, nowMs),
  );
  const spendControl = getRecord(raw, ["spend_control", "spendControl"]);

  const snapshotWithoutSummary = {
    providerName: input.providerName,
    fetchedAt,
    planType: getString(raw, ["plan_type", "planType"]),
    limitReached:
      getBoolean(rateLimit, ["limit_reached", "limitReached"]) ??
      getBoolean(spendControl, ["reached"]),
    rateLimitReachedType: getRateLimitReachedType(raw),
    primary,
    secondary,
    additional,
    credits: normalizeCredits(raw, rateLimit),
    individualLimit: normalizeIndividualLimit(raw, nowMs),
  };

  return {
    ...snapshotWithoutSummary,
    summary: formatChatGPTUsageSnapshot(
      snapshotWithoutSummary,
      new Date(nowMs),
    ),
  };
}

export function normalizeCloudChatGPTUsageResponse(input: {
  raw: unknown;
  providerName: string;
  nowMs?: number;
}): ChatGPTUsageSnapshot | null {
  const raw = asRecord(input.raw);
  if (!raw) return null;

  const nowMs = input.nowMs ?? Date.now();
  const fetchedAt =
    getString(raw, ["fetchedAt", "fetched_at"]) ??
    new Date(nowMs).toISOString();
  const additional = getRecordArray(raw, [
    "additional",
    "additional_rate_limits",
    "additionalRateLimits",
  ])
    .map((window, index) =>
      normalizeCloudUsageWindow(window, `limit ${index + 1}`, nowMs),
    )
    .filter((window): window is ChatGPTUsageWindow => !!window);

  const snapshotWithoutSummary = {
    providerName:
      getString(raw, ["providerName", "provider_name"]) ?? input.providerName,
    fetchedAt,
    planType: getString(raw, ["planType", "plan_type"]),
    limitReached: getBoolean(raw, ["limitReached", "limit_reached"]),
    rateLimitReachedType: getString(raw, [
      "rateLimitReachedType",
      "rate_limit_reached_type",
    ]),
    primary: normalizeCloudUsageWindow(
      getValue(raw, ["primary", "primary_window", "primaryWindow"]),
      "primary",
      nowMs,
    ),
    secondary: normalizeCloudUsageWindow(
      getValue(raw, ["secondary", "secondary_window", "secondaryWindow"]),
      "secondary",
      nowMs,
    ),
    additional,
    credits: normalizeCredits(raw, raw),
    individualLimit: normalizeIndividualLimit(raw, nowMs),
  };

  return {
    ...snapshotWithoutSummary,
    summary:
      getString(raw, ["summary"]) ??
      formatChatGPTUsageSnapshot(snapshotWithoutSummary, new Date(nowMs)),
  };
}

async function readCloudChatGPTUsage(
  input: ReadChatGPTUsageInput,
  now: number,
): Promise<ChatGPTUsageReadResult> {
  const providerName = input.providerName?.trim();
  if (!providerName) {
    return chatGPTProviderError(
      "bad_request",
      "A ChatGPT provider name is required for cloud usage.",
    );
  }

  const credentialSettings = await readCloudCredentialSettings(
    input.getSettings,
  );
  if (!credentialSettings.success) return credentialSettings;
  const { settings } = credentialSettings;

  const baseUrl = cloudBaseUrl(settings);
  const cacheKey = `api:${baseUrl}:${providerName}`;
  const cached = usageCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const auth = await resolveCloudApiKey({
    settings,
    now,
    unauthorizedMessage: "Sign in with Letta to read ChatGPT usage.",
    refreshAccessToken: input.refreshAccessToken,
  });
  if (!auth.success) return auth;

  const url = new URL(`${baseUrl}${CLOUD_CHATGPT_USAGE_PATH}`);
  url.searchParams.set("provider_name", providerName);

  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      headers: cloudRequestHeaders(auth.apiKey),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    return chatGPTProviderError(
      "network_error",
      didTimeOut
        ? "Letta Cloud ChatGPT usage request timed out."
        : error instanceof Error
          ? error.message
          : "Failed to fetch ChatGPT usage from Letta Cloud.",
    );
  }

  try {
    if (response.status === 400) {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        didTimeOut ? "network_error" : "bad_request",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(
              raw,
              "Letta Cloud rejected the ChatGPT usage request.",
            ),
      );
    }
    if (response.status === 401) {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        didTimeOut ? "network_error" : "unauthorized",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(raw, "Sign in with Letta to read ChatGPT usage."),
      );
    }
    if (response.status === 403) {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        didTimeOut ? "network_error" : "forbidden",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(
              raw,
              "ChatGPT usage is not available for this account.",
            ),
      );
    }
    if (response.status === 404) {
      const raw = await readJsonRecord(response);
      if (didTimeOut) {
        return chatGPTProviderError(
          "network_error",
          "Letta Cloud ChatGPT usage request timed out.",
        );
      }
      if (!raw) {
        return chatGPTProviderError(
          "network_error",
          "Letta Cloud ChatGPT usage endpoint is unavailable.",
        );
      }
      return chatGPTProviderError(
        "not_connected",
        responseMessage(raw, "No cloud ChatGPT OAuth provider is connected."),
      );
    }
    if (response.status === 429) {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        "rate_limited",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(
              raw,
              "ChatGPT usage is rate limited. Try again later.",
            ),
        retryAfterMsFromBody(raw) ?? retryAfterMs(response),
      );
    }
    if (!response.ok) {
      const raw = await readJsonRecord(response);
      return chatGPTProviderError(
        "network_error",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(
              raw,
              `Letta Cloud ChatGPT usage request failed with HTTP ${response.status}.`,
            ),
      );
    }

    const raw = await readJsonRecord(response);
    if (!raw) {
      return chatGPTProviderError(
        didTimeOut ? "network_error" : "bad_response",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : "Letta Cloud ChatGPT usage returned invalid JSON.",
      );
    }

    const usage = normalizeCloudChatGPTUsageResponse({
      raw,
      providerName,
      nowMs: now,
    });
    if (!usage) {
      return chatGPTProviderError(
        "bad_response",
        "Letta Cloud ChatGPT usage returned an invalid payload.",
      );
    }

    const result: Extract<ChatGPTUsageReadResult, { success: true }> = {
      success: true,
      usage,
    };
    usageCache.set(cacheKey, {
      expiresAt: now + CHATGPT_PROVIDER_CACHE_TTL_MS,
      result,
    });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

export async function readChatGPTUsage(
  input: ReadChatGPTUsageInput = {},
): Promise<ChatGPTUsageReadResult> {
  const target = input.target ?? "local";
  const now = input.now?.() ?? Date.now();
  if (target === "api") {
    return readCloudChatGPTUsage(input, now);
  }
  if (target !== "local") {
    return chatGPTProviderError(
      "unsupported_target",
      "ChatGPT usage is only available for local or cloud ChatGPT OAuth providers.",
    );
  }

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

  const cacheKey = `${target}:${record.name}`;
  const cached = usageCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  const localHeaders = await localChatGPTRequestHeaders(
    record,
    input.storageDir,
  );
  if (!localHeaders.success) return localHeaders;

  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? CHATGPT_PROVIDER_REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(CHATGPT_USAGE_URL, {
      method: "GET",
      headers: localHeaders.headers,
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    return chatGPTProviderError(
      "network_error",
      didTimeOut
        ? "ChatGPT usage request timed out."
        : error instanceof Error
          ? error.message
          : "Failed to fetch ChatGPT usage.",
    );
  }

  try {
    if (response.status === 401) {
      return chatGPTProviderError(
        "unauthorized",
        "ChatGPT rejected the OAuth token. Reconnect ChatGPT Plus/Pro and try again.",
      );
    }
    if (response.status === 403) {
      return chatGPTProviderError(
        "forbidden",
        "ChatGPT usage is not available for this account.",
      );
    }
    if (response.status === 429) {
      return chatGPTProviderError(
        "rate_limited",
        "ChatGPT usage is rate limited. Try again later.",
        retryAfterMs(response),
      );
    }
    if (!response.ok) {
      return chatGPTProviderError(
        "network_error",
        `ChatGPT usage request failed with HTTP ${response.status}.`,
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return chatGPTProviderError(
        didTimeOut ? "network_error" : "bad_response",
        didTimeOut
          ? "ChatGPT usage request timed out."
          : "ChatGPT usage returned invalid JSON.",
      );
    }

    const result: Extract<ChatGPTUsageReadResult, { success: true }> = {
      success: true,
      usage: normalizeWhamUsageResponse({
        raw,
        providerName: record.name,
        nowMs: now,
      }),
    };
    usageCache.set(cacheKey, {
      expiresAt: now + CHATGPT_PROVIDER_CACHE_TTL_MS,
      result,
    });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
