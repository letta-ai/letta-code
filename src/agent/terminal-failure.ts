import { APIError } from "@letta-ai/letta-client/core/error";
import { ApiRequestError } from "@/backend/api/request";
import type { TerminalFailure } from "@/types/terminal-failure";

const MAX_MACHINE_FIELD_LENGTH = 128;
const MAX_MESSAGE_LENGTH = 512;
const MAX_CLIENT_MESSAGE_IDS = 32;
const MAX_CLIENT_MESSAGE_ID_LENGTH = 256;
const MACHINE_FIELD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function parseResponseBody(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof ApiRequestError)) return null;
  try {
    return asRecord(JSON.parse(error.responseText));
  } catch {
    return null;
  }
}

function machineField(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_MACHINE_FIELD_LENGTH ||
    !MACHINE_FIELD_PATTERN.test(value)
  ) {
    return null;
  }
  return value;
}

function recordsFromError(error: unknown): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const append = (value: unknown): void => {
    const record = asRecord(value);
    if (!record) return;
    records.push(record);
    const nested = asRecord(record.error);
    if (nested) records.push(nested);
  };

  if (error instanceof APIError) append(error.error);
  append(parseResponseBody(error));
  append(error);
  return records;
}

function extractFailureCode(
  error: unknown,
  details: unknown,
  fallback: string,
): string {
  const records = [...recordsFromError(error), ...recordsFromError(details)];
  const reasons = records.flatMap((record) =>
    Array.isArray(record.reasons)
      ? record.reasons.flatMap((reason) => {
          const parsed = machineField(reason);
          return parsed ? [parsed] : [];
        })
      : [],
  );
  if (reasons.includes("not-enough-credits")) {
    return "not-enough-credits";
  }

  for (const record of records) {
    for (const key of [
      "errorCode",
      "error_code",
      "code",
      "error_type",
      "type",
    ]) {
      const parsed = machineField(record[key]);
      if (parsed) return parsed;
    }
  }

  return reasons[0] ?? fallback;
}

function extractHttpStatus(error: unknown, details: unknown): number | null {
  for (const value of [error, details]) {
    const status = asRecord(value)?.status;
    if (typeof status === "number" && Number.isInteger(status)) {
      return status >= 100 && status <= 599 ? status : null;
    }
  }
  return null;
}

function sanitizeMessage(value: string): string {
  const withoutControls = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
  const normalized = withoutControls.replace(/\s+/g, " ").trim();
  return (normalized || "The operation failed.").slice(0, MAX_MESSAGE_LENGTH);
}

function isRetryable(status: number | null, code: string): boolean {
  if (status === 408 || status === 429 || (status !== null && status >= 500)) {
    return true;
  }
  return /(?:timeout|temporar|unavailable|connection|llm_api_error)/i.test(
    code,
  );
}

function fallbackCode(stage: string): string {
  const normalized = stage.replace(/_/g, "-");
  return `${normalized}-failed`;
}

export function createTerminalFailure(params: {
  stage: string;
  message: string;
  error?: unknown;
  details?: unknown;
  retryable?: boolean;
  clientMessageIds?: string[];
}): TerminalFailure {
  const stage = machineField(params.stage) ?? "unknown";
  const code = extractFailureCode(
    params.error,
    params.details,
    fallbackCode(stage),
  );
  const httpStatus = extractHttpStatus(params.error, params.details);
  return {
    stage,
    code,
    message: sanitizeMessage(params.message),
    http_status: httpStatus,
    retryable: params.retryable ?? isRetryable(httpStatus, code),
    client_message_ids: [
      ...new Set(
        (params.clientMessageIds ?? []).filter(
          (id) => id.length > 0 && id.length <= MAX_CLIENT_MESSAGE_ID_LENGTH,
        ),
      ),
    ].slice(0, MAX_CLIENT_MESSAGE_IDS),
  };
}

export class TerminalFailureError extends Error {
  constructor(readonly failure: TerminalFailure) {
    super(failure.message);
    this.name = "TerminalFailureError";
  }
}

export function createEnvironmentTerminalFailure(
  error: unknown,
  stage:
    | "sandbox_start"
    | "environment_connect"
    | "environment_dispatch"
    | "environment_turn",
): TerminalFailure {
  if (error instanceof TerminalFailureError) return error.failure;

  const code = extractFailureCode(error, undefined, fallbackCode(stage));
  const message =
    code === "SANDBOX_CREATION_FAILED"
      ? "The Cloud sandbox could not be started."
      : stage === "sandbox_start"
        ? "The Cloud sandbox could not be started."
        : stage === "environment_connect"
          ? "Could not connect to the execution environment."
          : stage === "environment_dispatch"
            ? "Could not send the prompt to the execution environment."
            : "The remote agent turn did not complete.";

  return createTerminalFailure({ stage, message, error });
}
