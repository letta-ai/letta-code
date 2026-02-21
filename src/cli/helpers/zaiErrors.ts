/**
 * Z.ai-specific error detection, parsing, and formatting.
 *
 * Z.ai is an upstream LLM provider using the OpenAI-compatible API.
 * Errors arrive wrapped in generic "OpenAI" error messages from the server's
 * openai_client.py. This module extracts Z.ai's own error codes and presents
 * clear, actionable messages attributed to Z.ai.
 *
 * Z.ai error code ranges:
 *   1000-1004  Auth (authentication failed, token expired, invalid token)
 *   1100-1121  Account (inactive, locked, arrears, irregular activity)
 *   1200-1234  API call (invalid params, unsupported model, permissions, network)
 *   1300-1310  Rate/policy (content filtered, rate limit, quota, subscription expired)
 *   500        Internal server error
 */

// Regex patterns to extract Z.ai's {code, message} from error detail strings.
// Python dict repr: {'code': 1302, 'message': 'High concurrency...'}
const PYTHON_REPR_PATTERN = /'code':\s*(\d{3,4}),\s*'message':\s*'([^']+)'/;
// JSON format: {"code": 1302, "message": "High concurrency..."}
const JSON_FORMAT_PATTERN = /"code":\s*(\d{3,4}),\s*"message":\s*"([^"]+)"/;

function isKnownZaiCode(code: number): boolean {
  return (
    code === 500 ||
    (code >= 1000 && code <= 1004) ||
    (code >= 1100 && code <= 1121) ||
    (code >= 1200 && code <= 1234) ||
    (code >= 1300 && code <= 1310)
  );
}

/**
 * Parse a Z.ai error from an error detail string.
 * Returns the extracted code and message, or null if not a Z.ai error.
 */
export function parseZaiError(
  text: string,
): { code: number; message: string } | null {
  for (const pattern of [PYTHON_REPR_PATTERN, JSON_FORMAT_PATTERN]) {
    const match = text.match(pattern);
    if (match?.[1] && match[2]) {
      const code = parseInt(match[1], 10);
      if (isKnownZaiCode(code)) {
        return { code, message: match[2] };
      }
    }
  }
  return null;
}

/**
 * Format a Z.ai error code and message into a user-friendly string.
 */
export function formatZaiError(code: number, message: string): string {
  if (code >= 1000 && code <= 1004) {
    return `Z.ai authentication error: ${message}. Check your Z.ai API key with /connect.`;
  }
  if (code >= 1100 && code <= 1121) {
    return `Z.ai account issue: ${message}. Check your Z.ai account status.`;
  }
  if (code >= 1200 && code <= 1234) {
    return `Z.ai API error: ${message}. Try again later or switch providers with /model.`;
  }
  if (code >= 1300 && code <= 1310) {
    return `Z.ai rate limit: ${message}. This is a Z.ai limitation. Try again later or switch providers with /model.`;
  }
  if (code === 500) {
    return `Z.ai internal error. Try again later or switch providers with /model.`;
  }
  return `Z.ai error (${code}): ${message}`;
}

/**
 * Check if an error string contains a Z.ai error. If so, return a formatted
 * user-friendly message; otherwise return undefined.
 */
export function checkZaiError(errorText: string): string | undefined {
  const parsed = parseZaiError(errorText);
  if (!parsed) return undefined;
  return formatZaiError(parsed.code, parsed.message);
}

/**
 * Returns true if the error detail contains a Z.ai error code in ranges that
 * should not be retried (auth, account, rate/policy).
 */
export function isZaiNonRetryableError(detail: string): boolean {
  const parsed = parseZaiError(detail);
  if (!parsed) return false;
  const { code } = parsed;
  return (
    (code >= 1000 && code <= 1004) ||
    (code >= 1100 && code <= 1121) ||
    (code >= 1300 && code <= 1310)
  );
}
