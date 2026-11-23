interface ErrorWithStatus {
  status?: number;
  message?: unknown;
  error?: {
    detail?: unknown;
    message?: unknown;
    error?: {
      detail?: unknown;
      message?: unknown;
    };
  };
}

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeDiscordInlineCode(value: string): string {
  return value.replace(/`/g, "\\`").replace(/\r?\n/g, " ");
}

export function extractErrorDetail(error: unknown): string {
  const e = error as ErrorWithStatus | null | undefined;
  return (
    readTrimmedString(e?.error?.error?.detail) ||
    readTrimmedString(e?.error?.error?.message) ||
    readTrimmedString(e?.error?.detail) ||
    readTrimmedString(e?.error?.message) ||
    readTrimmedString(e?.message) ||
    String(error)
  );
}

export function formatDiscordDeliveryError(error: unknown): string {
  const status = (error as ErrorWithStatus | null | undefined)?.status;
  const detail = extractErrorDetail(error);

  if (status === 404 && /Agent with ID .* not found/i.test(detail)) {
    return (
      "Sorry, I couldn't deliver your message — the agent I'm bound to " +
      "wasn't found. The operator needs to rebind this bot with " +
      "`letta channels bind --channel discord --agent <id>`."
    );
  }

  if (status === 401 || status === 403) {
    return (
      "Sorry, I couldn't deliver your message — my Letta API credentials " +
      "were rejected. The operator needs to check the API key."
    );
  }

  const MAX_DETAIL = 200;
  const truncated =
    detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}…` : detail;
  const safeDetail = escapeDiscordInlineCode(truncated);
  return `Sorry, something went wrong while forwarding your message: \`${safeDetail}\``;
}
