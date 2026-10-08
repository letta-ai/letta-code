const REDACTED = "[REDACTED]";
const REDACTED_RAW = "[REDACTED_UNPARSEABLE_WS_PAYLOAD]";

const ALWAYS_SENSITIVE_KEYS = new Set([
  "access_token",
  "authorization_code",
  "client_secret",
  "credentials",
  "handoff_key",
  "id_token",
  "raw",
  "refresh_token",
  "token",
]);
const OAUTH_CONTEXT_SENSITIVE_KEYS = new Set([
  "code",
  "error",
  "provider_response",
  "state",
]);

/**
 * Return a detached, log-safe representation of a WebSocket event.
 *
 * Unambiguously secret fields are always redacted. Generic diagnostic fields
 * such as `error` and `state` are redacted only for browser-device OAuth frames,
 * so unrelated protocol diagnostics remain useful. Raw malformed payloads are
 * never copied into logs.
 */
export function redactWsEventForLogging(event: unknown): unknown {
  return redactValue(
    event,
    new WeakSet<object>(),
    isBrowserDeviceMcpOAuthValue(event),
  );
}

function redactValue(
  value: unknown,
  seen: WeakSet<object>,
  oauthContext: boolean,
): unknown {
  if (typeof value === "string") {
    return redactString(value, seen, oauthContext);
  }
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return value;
  }
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, seen, oauthContext));
    }
    const record = value as Record<string, unknown>;
    const nestedOAuthContext =
      oauthContext || isBrowserDeviceMcpOAuthValue(record);
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) {
      const normalizedKey = key.toLowerCase();
      const sensitive =
        ALWAYS_SENSITIVE_KEYS.has(normalizedKey) ||
        (nestedOAuthContext && OAUTH_CONTEXT_SENSITIVE_KEYS.has(normalizedKey));
      result[key] = sensitive
        ? normalizedKey === "raw"
          ? REDACTED_RAW
          : REDACTED
        : redactValue(item, seen, nestedOAuthContext);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function redactString(
  value: string,
  seen: WeakSet<object>,
  oauthContext: boolean,
): string | unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return redactValue(
      parsed,
      seen,
      oauthContext || isBrowserDeviceMcpOAuthValue(parsed),
    );
  } catch {
    return REDACTED_RAW;
  }
}

function isBrowserDeviceMcpOAuthValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes('"type":"browser_device_mcp_oauth');
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return (
    typeof type === "string" && type.startsWith("browser_device_mcp_oauth")
  );
}
