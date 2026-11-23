export function safeJsonParseOr<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}
