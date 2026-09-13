/**
 * Error handling utilities
 */

/**
 * Extract an error message without letting hostile values throw during coercion.
 */
export function getErrorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "Unknown error";
  }
}
