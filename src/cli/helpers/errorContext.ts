/**
 * Global context for error formatting.
 * Allows the error formatter to access user/agent context without threading it through every call site.
 */

interface ErrorContext {
  billingTier?: string;
  modelDisplayName?: string;
}

let currentContext: ErrorContext = {};

/**
 * Set the error context (call when agent loads or billing info is fetched)
 */
export function setErrorContext(context: Partial<ErrorContext>): void {
  currentContext = { ...currentContext, ...context };
}

/**
 * Get the current error context
 */
export function getErrorContext(): ErrorContext {
  return currentContext;
}

/**
 * Clear the error context
 */
export function clearErrorContext(): void {
  currentContext = {};
}
