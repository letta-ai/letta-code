const DEFAULT_TAIL_CHARS = 4000;

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
