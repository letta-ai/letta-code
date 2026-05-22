/**
 * Safe JSON parser that returns the parsed value or a default value
 */
export function safeJsonParseOr<T>(json: string, defaultValue: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return defaultValue;
  }
}
