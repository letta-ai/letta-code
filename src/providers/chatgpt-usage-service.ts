import {
  getLocalOAuthApiKey,
  getLocalProviderRecordByName,
  LOCAL_CHATGPT_PROVIDER_NAME,
  type LocalProviderRecord,
} from "@/backend/local/local-provider-auth-store";
import type { ProviderStorageTarget } from "@/providers/byok-providers";

const CHATGPT_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OPENAI_CODEX_OAUTH_PROVIDER_ID = "openai-codex";
const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

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
}

export type ChatGPTUsageErrorCode =
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
    if (key in record) return record[key];
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
  if (!credits) return null;

  const balance = getString(credits, ["balance", "credit_balance", "amount"]);
  const availableCount = getNumber(credits, [
    "available_count",
    "availableCount",
    "count",
  ]);
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

function formatUsageWindow(
  window: ChatGPTUsageWindow | null,
  now: Date,
): string | null {
  if (!window) return null;

  const label = formatWindowLabel(window);
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
    ...snapshot.additional.map((window) => formatUsageWindow(window, now)),
  ].filter((item): item is string => !!item);

  const credits = formatCredits(snapshot.credits);
  if (credits) windows.push(credits);

  if (windows.length === 0) {
    return "Usage: no active quota window reported";
  }
  return `Usage: ${windows.join(" · ")}`;
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
  const additional = getRecordArray(rateLimit, [
    "additional_rate_limits",
    "additionalRateLimits",
    "additional",
  ])
    .map((window, index) =>
      normalizeUsageWindow(
        window,
        getString(window, ["label", "name", "model", "limit_id", "limitId"]) ??
          `limit ${index + 1}`,
        nowMs,
      ),
    )
    .filter((window): window is ChatGPTUsageWindow => !!window);

  const snapshotWithoutSummary = {
    providerName: input.providerName,
    fetchedAt,
    planType: getString(raw, ["plan_type", "planType"]),
    limitReached: getBoolean(rateLimit, ["limit_reached", "limitReached"]),
    rateLimitReachedType: getString(raw, [
      "rate_limit_reached_type",
      "rateLimitReachedType",
    ]),
    primary,
    secondary,
    additional,
    credits: normalizeCredits(raw, rateLimit),
  };

  return {
    ...snapshotWithoutSummary,
    summary: formatChatGPTUsageSnapshot(
      snapshotWithoutSummary,
      new Date(nowMs),
    ),
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

export async function readChatGPTUsage(
  input: ReadChatGPTUsageInput = {},
): Promise<ChatGPTUsageReadResult> {
  const target = input.target ?? "local";
  if (target !== "local") {
    return chatGPTUsageError(
      "unsupported_target",
      "ChatGPT usage is only available for locally stored ChatGPT OAuth providers.",
    );
  }

  const now = input.now?.() ?? Date.now();
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
  const timeout = setTimeout(
    () => controller.abort(),
    input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

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
    return chatGPTUsageError(
      "network_error",
      error instanceof Error ? error.message : "Failed to fetch ChatGPT usage.",
    );
  } finally {
    clearTimeout(timeout);
  }

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
      "bad_response",
      "ChatGPT usage returned invalid JSON.",
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
}
