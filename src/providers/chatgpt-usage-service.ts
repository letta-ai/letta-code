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
import type { ProviderStorageTarget } from "@/providers/byok-providers";
import { type Settings, settingsManager } from "@/settings-manager";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const CLOUD_CHATGPT_USAGE_PATH = "/v1/providers/chatgpt-usage";
const OPENAI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";
const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;

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
  getSettings?: () => Promise<
    Pick<Settings, "env" | "refreshToken" | "tokenExpiresAt">
  >;
  refreshAccessToken?: (
    refreshToken: string,
    deviceId: string,
    deviceName?: string,
  ) => Promise<TokenResponse>;
}

type JsonRecord = Record<string, unknown>;

type CachedUsage = {
  expiresAt: number;
  result: Extract<ChatGPTUsageReadResult, { success: true }>;
};

const usageCache = new Map<string, CachedUsage>();

function asRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function getValue(record: JsonRecord | undefined, keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

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

function getNumber(
  record: JsonRecord | undefined,
  keys: string[],
): number | null {
  const value = getValue(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function getString(
  record: JsonRecord | undefined,
  keys: string[],
): string | null {
  const value = getValue(record, keys);
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
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

function retryAfterMsFromBody(raw: JsonRecord | null): number | undefined {
  const value = getNumber(raw ?? undefined, ["retryAfterMs", "retry_after_ms"]);
  return value === null ? undefined : Math.max(0, value);
}

async function readJsonRecord(response: Response): Promise<JsonRecord | null> {
  try {
    return asRecord(await response.json()) ?? null;
  } catch {
    return null;
  }
}

function responseMessage(raw: JsonRecord | null, fallback: string): string {
  return (
    getString(raw ?? undefined, ["message", "error", "detail"]) ?? fallback
  );
}

function chatGPTUsageError(
  code: ChatGPTUsageErrorCode,
  message: string,
  retryAfter?: number,
): ChatGPTUsageReadResult {
  return {
    success: false,
    error: {
      code,
      message,
      ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
    },
  };
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
  refreshAccessToken?: ReadChatGPTUsageInput["refreshAccessToken"];
}): Promise<{ apiKey: string | null; error?: ChatGPTUsageError }> {
  const settings = input.settings;
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
      return {
        apiKey: null,
        error: {
          code: "refresh_failed",
          message:
            error instanceof Error
              ? error.message
              : "Failed to refresh the Letta Cloud access token.",
        },
      };
    }
  }

  if (!apiKey) {
    return {
      apiKey: null,
      error: {
        code: "unauthorized",
        message: "Sign in with Letta to read ChatGPT usage.",
      },
    };
  }

  return { apiKey };
}

function localProviderNames(providerName: string | undefined): string[] {
  if (providerName?.trim()) return [providerName.trim()];
  return [LOCAL_CHATGPT_PROVIDER_NAME, OPENAI_CODEX_OAUTH_PROVIDER_ID];
}

function isChatGPTOAuthRecord(
  record: LocalProviderRecord,
): record is LocalProviderRecord & {
  auth: { type: "oauth"; accountId?: string };
} {
  return (
    record.auth.type === "oauth" &&
    (record.provider_type === "chatgpt_oauth" ||
      record.provider_type === OPENAI_CODEX_OAUTH_PROVIDER_ID)
  );
}

function isConnectedChatGPTOAuthRecord(
  record: LocalProviderRecord | null,
): record is LocalProviderRecord & {
  auth: { type: "oauth"; accountId?: string };
} {
  return !!record && isChatGPTOAuthRecord(record);
}

async function readCloudChatGPTUsage(
  input: ReadChatGPTUsageInput,
  now: number,
): Promise<ChatGPTUsageReadResult> {
  const providerName = input.providerName?.trim();
  if (!providerName) {
    return chatGPTUsageError(
      "bad_request",
      "A ChatGPT provider name is required for cloud usage.",
    );
  }

  let settings: Pick<Settings, "env" | "refreshToken" | "tokenExpiresAt">;
  try {
    settings = await (
      input.getSettings ?? (() => settingsManager.getSettingsWithSecureTokens())
    )();
  } catch (error) {
    return chatGPTUsageError(
      "unauthorized",
      error instanceof Error
        ? error.message
        : "Failed to read Letta Cloud credentials.",
    );
  }

  const baseUrl = cloudBaseUrl(settings);
  const cacheKey = `api:${baseUrl}:${providerName}`;
  const cached = usageCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

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
        message: "Sign in with Letta to read ChatGPT usage.",
      },
    };
  }

  const url = new URL(`${baseUrl}${CLOUD_CHATGPT_USAGE_PATH}`);
  url.searchParams.set("provider_name", providerName);

  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      headers: {
        ...getLettaCodeHeaders(auth.apiKey),
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    return chatGPTUsageError(
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
      return chatGPTUsageError(
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
      return chatGPTUsageError(
        didTimeOut ? "network_error" : "unauthorized",
        didTimeOut
          ? "Letta Cloud ChatGPT usage request timed out."
          : responseMessage(raw, "Sign in with Letta to read ChatGPT usage."),
      );
    }
    if (response.status === 403) {
      const raw = await readJsonRecord(response);
      return chatGPTUsageError(
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
        return chatGPTUsageError(
          "network_error",
          "Letta Cloud ChatGPT usage request timed out.",
        );
      }
      if (!raw) {
        return chatGPTUsageError(
          "network_error",
          "Letta Cloud ChatGPT usage endpoint is unavailable.",
        );
      }
      return chatGPTUsageError(
        "not_connected",
        responseMessage(raw, "No cloud ChatGPT OAuth provider is connected."),
      );
    }
    if (response.status === 429) {
      const raw = await readJsonRecord(response);
      return chatGPTUsageError(
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
      return chatGPTUsageError(
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
      return chatGPTUsageError(
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
      return chatGPTUsageError(
        "bad_response",
        "Letta Cloud ChatGPT usage returned an invalid payload.",
      );
    }

    const result: Extract<ChatGPTUsageReadResult, { success: true }> = {
      success: true,
      usage,
    };
    usageCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, result });
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
    return chatGPTUsageError(
      "unsupported_target",
      "ChatGPT usage is only available for local or cloud ChatGPT OAuth providers.",
    );
  }

  const providerNames = localProviderNames(input.providerName);
  const record = providerNames
    .map((name) => getLocalProviderRecordByName(name, input.storageDir))
    .find(isConnectedChatGPTOAuthRecord);

  if (!record) {
    return chatGPTUsageError(
      "not_connected",
      "No local ChatGPT OAuth provider is connected.",
    );
  }

  const cacheKey = `${target}:${record.name}`;
  const cached = usageCache.get(cacheKey);
  if (!input.forceRefresh && cached && cached.expiresAt > now) {
    return cached.result;
  }

  let oauthApiKey: Awaited<ReturnType<typeof getLocalOAuthApiKey>>;
  try {
    oauthApiKey = await getLocalOAuthApiKey({
      providerId: OPENAI_CODEX_OAUTH_PROVIDER_ID,
      providerNames: [record.name],
      storageDir: input.storageDir,
    });
  } catch (error) {
    return chatGPTUsageError(
      "refresh_failed",
      error instanceof Error
        ? error.message
        : "Failed to refresh the ChatGPT OAuth token.",
    );
  }

  if (!oauthApiKey) {
    return chatGPTUsageError(
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
  const controller = new AbortController();
  let didTimeOut = false;
  const timeout = setTimeout(() => {
    didTimeOut = true;
    controller.abort();
  }, input.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let response: Response;
  try {
    response = await (input.fetch ?? fetch)(CHATGPT_USAGE_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${oauthApiKey.apiKey}`,
        "User-Agent": "letta-code",
        ...(accountId ? { "chatgpt-account-id": accountId } : {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    return chatGPTUsageError(
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
      return chatGPTUsageError(
        "unauthorized",
        "ChatGPT rejected the OAuth token. Reconnect ChatGPT Plus/Pro and try again.",
      );
    }
    if (response.status === 403) {
      return chatGPTUsageError(
        "forbidden",
        "ChatGPT usage is not available for this account.",
      );
    }
    if (response.status === 429) {
      return chatGPTUsageError(
        "rate_limited",
        "ChatGPT usage is rate limited. Try again later.",
        retryAfterMs(response),
      );
    }
    if (!response.ok) {
      return chatGPTUsageError(
        "network_error",
        `ChatGPT usage request failed with HTTP ${response.status}.`,
      );
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      return chatGPTUsageError(
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
    usageCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, result });
    return result;
  } finally {
    clearTimeout(timeout);
  }
}
