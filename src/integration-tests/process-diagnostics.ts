const DEFAULT_TAIL_CHARS = 4000;

// Only categorical values are logged: wire messages can contain credentials,
// response bodies, prompts, and account-specific identifiers.
const FAILURE_CATEGORIES = new Set([
  "error",
  "interrupted",
  "llm_api_error",
  "invalid_llm_response",
  "invalid_tool_call",
  "max_steps",
  "max_tokens_exceeded",
  "no_tool_call",
  "tool_rule",
  "cancelled",
  "insufficient_credits",
  "context_window_overflow_in_system_prompt",
  "internal_error",
  "llm_error",
  "llm_authentication",
  "llm_rate_limit",
  "llm_insufficient_credits",
  "insufficient_credits_error",
]);

export function summarizeWireFailures<T extends { type: string }>(
  messages: readonly T[],
): string {
  const category = (value: unknown) =>
    typeof value === "string" && FAILURE_CATEGORIES.has(value)
      ? value
      : "unknown_or_omitted";
  const failures = messages.filter(
    (message) =>
      message.type === "error" ||
      (message.type === "result" &&
        (!("subtype" in message) || message.subtype !== "success")),
  );
  return JSON.stringify({
    failureCount: failures.length,
    recentFailures: failures.slice(-5).map((message) => {
      const apiError = "api_error" in message ? message.api_error : undefined;
      return {
        type: message.type === "error" ? "error" : "result",
        subtype: category("subtype" in message ? message.subtype : undefined),
        stopReason: category(
          "stop_reason" in message ? message.stop_reason : undefined,
        ),
        apiErrorType: category(
          apiError && typeof apiError === "object" && "error_type" in apiError
            ? apiError.error_type
            : undefined,
        ),
      };
    }),
  });
}

// Labels are static test-stage names, never command arguments or API data.
// Emit before awaiting so a process killed by the outer test timeout leaves
// the unfinished stage visible. Do not change deadlines or swallow failures.
export async function withTestStage<T>(
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  console.info(`[api-test] ${label} start`);
  let outcome = "failed";
  try {
    const result = await work();
    outcome = "completed";
    return result;
  } finally {
    console.info(
      `[api-test] ${label} ${outcome} elapsed_ms=${Math.round(performance.now() - startedAt)}`,
    );
  }
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
