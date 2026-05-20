import {
  getRetryDelayMs,
  isQuotaLimitErrorDetail,
  parseRetryAfterHeaderMs,
  shouldRetryPreStreamTransientError,
} from "@/agent/turn-recovery-policy";
import { isContextWindowOverflowError } from "./context-window-overflow";

export interface LocalProviderErrorInfo {
  message: string;
  detail: string;
  error_type: "llm_error" | "local_backend_error";
  retryable: boolean;
  stop_reason: "llm_api_error" | "error";
}

const LOCAL_PROVIDER_MAX_RETRY_DELAY_MS = 60_000;
const RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS = [
  "server_error",
  "server error",
  "internal_error",
  "internal error",
  "service_unavailable",
  "service unavailable",
  "temporarily_unavailable",
  "temporarily unavailable",
  "you can retry your request",
  "retry your request",
  "websocket closed",
  "websocket error",
  "connection ended",
  "connection lost",
  "other side closed",
  "fetch failed",
  "upstream connect",
  "reset before headers",
  "socket hang up",
  "ended without",
  "http2 request did not get a response",
  "timed out",
  "terminated",
  "retry delay",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function fallbackErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (isRecord(error) && typeof error.message === "string" && error.message) {
    return error.message;
  }
  if (isRecord(error) && isRecord(error.data)) {
    const dataMessage = error.data.message;
    if (typeof dataMessage === "string" && dataMessage) return dataMessage;
  }
  const text = String(error);
  if (text && text !== "[object Object]") return text;
  const serialized = stringifyValue(error);
  if (serialized && serialized !== "{}") return serialized;
  return "Unknown local provider error";
}

export function localProviderErrorDetail(error: unknown): string {
  const parts: string[] = [];
  const message = fallbackErrorMessage(error);
  if (message) parts.push(message);

  if (isRecord(error)) {
    for (const key of ["responseBody", "data", "body", "detail", "code"]) {
      const value = stringifyValue(error[key]);
      if (value) parts.push(value);
    }
    const cause = error.cause;
    if (isRecord(cause)) {
      const code = stringValue(cause.code);
      if (code) parts.push(code);
      const causeMessage = stringValue(cause.message);
      if (causeMessage) parts.push(causeMessage);
    } else if (cause instanceof Error) {
      parts.push(cause.message);
    }
  }

  return [...new Set(parts.filter(Boolean))].join("\n");
}

function parseRetryableJSONRecord(
  value: string,
): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const candidates = [trimmed];
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart > 0) candidates.push(trimmed.slice(jsonStart));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function isRetryableRateLimitJSONDetail(detail: string): boolean {
  const candidates = [detail, ...detail.split("\n")];
  for (const candidate of candidates) {
    const parsed = parseRetryableJSONRecord(candidate);
    if (!parsed) continue;

    const type = stringValue(parsed.type)?.toLowerCase();
    const topLevelCode = stringValue(parsed.code)?.toLowerCase();
    const nestedError = isRecord(parsed.error) ? parsed.error : undefined;
    const nestedType = stringValue(nestedError?.type)?.toLowerCase();
    const nestedCode = stringValue(nestedError?.code)?.toLowerCase();

    if (type === "error" && nestedType === "too_many_requests") return true;
    if (
      typeof topLevelCode === "string" &&
      (topLevelCode.includes("exhausted") ||
        topLevelCode.includes("unavailable"))
    ) {
      return true;
    }
    if (typeof nestedCode === "string" && nestedCode.includes("rate_limit")) {
      return true;
    }
  }
  return false;
}

function hasRetryableLocalProviderDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return RETRYABLE_LOCAL_PROVIDER_DETAIL_PATTERNS.some((pattern) =>
    normalized.includes(pattern),
  );
}

function statusCode(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  const status = error.statusCode ?? error.status;
  return typeof status === "number" ? status : undefined;
}

export function isRetryableLocalProviderError(error: unknown): boolean {
  if (isContextWindowOverflowError(error)) return false;

  const detail = localProviderErrorDetail(error);
  const status = statusCode(error);
  if (isQuotaLimitErrorDetail(detail)) return false;
  if (isRecord(error) && error.isRetryable === true) return true;
  if (status !== undefined && status >= 500) return true;
  if (status === undefined && isRetryableRateLimitJSONDetail(detail))
    return true;
  if (hasRetryableLocalProviderDetail(detail)) return true;
  return shouldRetryPreStreamTransientError({ status, detail });
}

function isLikelyProviderError(error: unknown, retryable: boolean): boolean {
  if (retryable || isContextWindowOverflowError(error)) return true;
  const detail = localProviderErrorDetail(error).toLowerCase();
  return (
    detail.includes("api") ||
    detail.includes("provider") ||
    detail.includes("rate limit") ||
    detail.includes("too many requests") ||
    detail.includes("overloaded") ||
    detail.includes("connection") ||
    detail.includes("socket") ||
    detail.includes("stream")
  );
}

export function normalizeLocalProviderError(
  error: unknown,
): LocalProviderErrorInfo {
  const retryable = isRetryableLocalProviderError(error);
  const detail = localProviderErrorDetail(error);
  const message = fallbackErrorMessage(error);
  const isProviderError = isLikelyProviderError(error, retryable);
  return {
    message,
    detail,
    error_type: isProviderError ? "llm_error" : "local_backend_error",
    retryable,
    stop_reason: retryable ? "llm_api_error" : "error",
  };
}

export function localProviderRetryDelayMs(
  error: unknown,
  attempt: number,
): number {
  const detail = localProviderErrorDetail(error);
  const retryAfterMs =
    detail
      .split("\n")
      .map((line) => line.match(/retry-after(?:-ms)?:\s*([^\s]+)/i)?.[1])
      .filter((value): value is string => Boolean(value))
      .map(parseRetryAfterHeaderMs)
      .find((value) => value !== null) ?? null;
  return Math.min(
    getRetryDelayMs({
      category: "transient_provider",
      attempt,
      detail,
      retryAfterMs,
    }),
    LOCAL_PROVIDER_MAX_RETRY_DELAY_MS,
  );
}

export function localProviderRetryMessage(error: unknown): string {
  const status = statusCode(error);
  return `${status !== undefined ? `HTTP ${status}: ` : ""}${fallbackErrorMessage(error)}`;
}
