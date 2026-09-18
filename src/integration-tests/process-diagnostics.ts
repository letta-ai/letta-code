const DEFAULT_TAIL_CHARS = 4000;

// Cloud-send errors can contain response bodies and credentials. Report only
// known states and numeric fields, never the free-text error or captured output.
export function summarizeCloudSendExit(
  output: Record<string, unknown>,
): string {
  const statuses = [
    "completed",
    "wait_failed",
    "acceptance_unknown",
    "submission_failed",
  ];
  const status =
    typeof output.status === "string" && statuses.includes(output.status)
      ? output.status
      : "unknown_or_omitted";
  const httpStatus =
    typeof output.http_status === "number" &&
    Number.isInteger(output.http_status) &&
    output.http_status >= 100 &&
    output.http_status <= 599
      ? output.http_status
      : "unknown_or_omitted";
  return formatCapturedOutput({
    extra: {
      status,
      http_status: httpStatus,
      is_error:
        typeof output.is_error === "boolean"
          ? output.is_error
          : "unknown_or_omitted",
      receipt_present: output.receipt !== undefined,
      observed_run_count: Array.isArray(output.run_ids)
        ? output.run_ids.length
        : "unknown_or_omitted",
    },
  });
}

function tailText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "(empty)";
  }
  return trimmed.length <= maxChars
    ? trimmed
    : `...${trimmed.slice(-maxChars)}`;
}

export function formatCapturedOutput(params: {
  stdout?: string;
  stderr?: string;
  extra?: Record<string, unknown>;
  maxChars?: number;
}): string {
  const maxChars = params.maxChars ?? DEFAULT_TAIL_CHARS;
  const lines: string[] = [];

  if (params.extra) {
    for (const [key, value] of Object.entries(params.extra)) {
      if (value === undefined) {
        continue;
      }
      lines.push(`${key}: ${String(value)}`);
    }
  }

  if (params.stdout !== undefined) {
    lines.push(`stdout tail:\n${tailText(params.stdout, maxChars)}`);
  }

  if (params.stderr !== undefined) {
    lines.push(`stderr tail:\n${tailText(params.stderr, maxChars)}`);
  }

  return lines.join("\n");
}

export function formatAttemptDiagnostics(
  attempts: Array<{
    attempt: number;
    message: string;
  }>,
): string {
  if (attempts.length === 0) {
    return "";
  }

  return attempts
    .map(
      ({ attempt, message }) =>
        `attempt ${attempt} diagnostics:\n${message.trim()}`,
    )
    .join("\n\n");
}

export function summarizeRecentMessages(
  messages: Array<Record<string, unknown>>,
  maxCount = 5,
): string {
  const recent = messages.slice(-maxCount);
  if (recent.length === 0) {
    return "(none)";
  }

  return recent
    .map((message) => {
      const parts = [`type=${String(message.type ?? "unknown")}`];
      if (typeof message.subtype === "string") {
        parts.push(`subtype=${message.subtype}`);
      }
      if (typeof message.message_type === "string") {
        parts.push(`message_type=${message.message_type}`);
      }
      if (typeof message.recovery_type === "string") {
        parts.push(`recovery_type=${message.recovery_type}`);
      }
      return parts.join(" ");
    })
    .join(" | ");
}
