/**
 * Safe JSON parser that never throws
 * Returns parsed value on success, or null on failure
 */
export function safeJsonParse<T = unknown>(
  json: string,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const data = JSON.parse(json) as T;
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Safe JSON parser that returns the parsed value or a default value
 */
export function safeJsonParseOr<T>(json: string, defaultValue: T): T {
  const result = safeJsonParse<T>(json);
  return result.success ? result.data : defaultValue;
}
