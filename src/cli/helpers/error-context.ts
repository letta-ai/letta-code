interface ErrorContext {
  billingTier?: string;
  modelDisplayName?: string;
  modelEndpointType?: string;
  modelLabel?: string;
}

let currentContext: ErrorContext = {};

export function setErrorContext(context: Partial<ErrorContext>): void {
  currentContext = { ...currentContext, ...context };
}

export function getErrorContext(): ErrorContext {
  return currentContext;
}

export function clearErrorContext(): void {
  currentContext = {};
}
