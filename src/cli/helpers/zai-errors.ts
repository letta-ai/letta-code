const PYTHON_REPR_PATTERN = /'code':\s*(\d{3,4}),\s*'message':\s*'([^']+)'/;
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

export function checkZaiError(errorText: string): string | undefined {
  const parsed = parseZaiError(errorText);
  if (!parsed) return undefined;
  return formatZaiError(parsed.code, parsed.message);
}

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
