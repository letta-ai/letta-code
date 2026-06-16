export function parseUrl(
  value: string,
  options: { allowMissingProtocol?: boolean } = {},
): URL | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.hostname) {
      return parsed;
    }
  } catch {
    // Fall through to optional http:// fallback below.
  }

  if (!options.allowMissingProtocol) {
    return null;
  }

  try {
    const parsed = new URL(`http://${trimmed}`);
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "0.0.0.0" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.")
  );
}

export function isLoopbackUrl(
  value: string,
  options: { allowMissingProtocol?: boolean } = {},
): boolean {
  const parsed = parseUrl(value, options);
  return Boolean(parsed && isLoopbackHostname(parsed.hostname));
}
