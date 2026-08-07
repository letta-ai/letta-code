import type { RetryMessage } from "@/types/protocol_v2";
import { createLifecycleMessageBase } from "./protocol-outbound";

export interface CloudRetryMessage {
  message: string;
  retryKind: "provider_retry" | "transport_fallback";
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  provider: string;
  fromTransport: string | null;
  toTransport: string | null;
  errorCode: string | null;
  runId: string | null;
  stepId: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseCloudRetryMessage(
  value: unknown,
): CloudRetryMessage | null {
  if (!isRecord(value) || value.message_type !== "retry_message") {
    return null;
  }

  const attempt = value.attempt;
  const maxAttempts = value.max_attempts;
  const delayMs = value.delay_ms;
  const retryKind = value.retry_kind;
  if (
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    (retryKind !== "provider_retry" && retryKind !== "transport_fallback") ||
    typeof attempt !== "number" ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    typeof maxAttempts !== "number" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < attempt ||
    typeof delayMs !== "number" ||
    !Number.isFinite(delayMs) ||
    delayMs < 0 ||
    typeof value.provider !== "string" ||
    value.provider.length === 0
  ) {
    return null;
  }

  return {
    message: value.message,
    retryKind,
    attempt,
    maxAttempts,
    delayMs,
    provider: value.provider,
    fromTransport: optionalString(value.from_transport),
    toTransport: optionalString(value.to_transport),
    errorCode: optionalString(value.error_code),
    runId: optionalString(value.run_id),
    stepId: optionalString(value.step_id),
  };
}

export function normalizeCloudRetryWireMessage(
  value: unknown,
): RetryMessage | null {
  const retry = parseCloudRetryMessage(value);
  if (!retry) {
    return null;
  }

  return {
    ...createLifecycleMessageBase("retry", retry.runId),
    message: retry.message,
    reason: "llm_api_error",
    attempt: retry.attempt,
    max_attempts: retry.maxAttempts,
    delay_ms: retry.delayMs,
    retry_kind: retry.retryKind,
    provider: retry.provider,
    from_transport: retry.fromTransport,
    to_transport: retry.toTransport,
    error_code: retry.errorCode,
    step_id: retry.stepId,
  };
}
