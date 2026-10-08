const REDACTED = "[REDACTED]";
const REDACTED_RAW = "[REDACTED_UNPARSEABLE_WS_PAYLOAD]";

const SENSITIVE_KEYS = new Set([
  "access_token",
  "authorization_code",
  "client_secret",
  "code",
  "credentials",
  "error",
  "handoff_key",
  "id_token",
  "provider_response",
  "raw",
  "refresh_token",
  "state",
  "token",
]);

/**
 * Return a detached, log-safe representation of a WebSocket event.
 *
 * Parsed fields are recursively redacted. Raw strings are parsed and redacted
 * when possible; malformed payloads are never copied into logs because their
 * structure cannot be trusted to expose secret-bearing field boundaries.
 */
export function redactWsEventForLogging(event: unknown): unknown {
  return redactValue(event, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value, seen);
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, seen));
    }
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = SENSITIVE_KEYS.has(key.toLowerCase())
        ? key.toLowerCase() === "raw"
          ? REDACTED_RAW
          : REDACTED
        : redactValue(item, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function redactString(value: string, seen: WeakSet<object>): string | unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return redactValue(JSON.parse(trimmed) as unknown, seen);
  } catch {
    return REDACTED_RAW;
  }
}
