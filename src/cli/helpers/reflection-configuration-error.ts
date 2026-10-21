import stripAnsi from "strip-ansi";

export type ReflectionConfigurationErrorKind =
  | "model_handle_not_found"
  | "model_provider_not_registered"
  | "unknown_model";

export interface ReflectionConfigurationError {
  kind: ReflectionConfigurationErrorKind;
  message: string;
}

function matchQuotedValue(error: string, pattern: RegExp): string | undefined {
  const value = error.match(pattern)?.[1];
  if (!value) return undefined;
  return stripAnsi(value).replaceAll(/\s+/g, " ").trim().slice(0, 200);
}

export function classifyReflectionConfigurationError(
  error: string | undefined,
): ReflectionConfigurationError | undefined {
  if (!error) return undefined;
  const normalizedError = error.replaceAll('\\"', '"');

  const provider = matchQuotedValue(
    normalizedError,
    /model provider ["']([^"']+)["'] is not registered/i,
  );
  if (provider) {
    return {
      kind: "model_provider_not_registered",
      message: `Model provider "${provider}" is not registered.`,
    };
  }

  const unknownModelMatch = normalizedError.match(
    /unknown model ["']([^"']+)["'] for provider ["']([^"']+)["']/i,
  );
  if (unknownModelMatch?.[1] && unknownModelMatch[2]) {
    return {
      kind: "unknown_model",
      message: `Model "${unknownModelMatch[1]}" is not available from provider "${unknownModelMatch[2]}".`,
    };
  }

  const modelHandle =
    matchQuotedValue(
      normalizedError,
      /model handle not found:\s*([^\s"'}]+)/i,
    ) ??
    matchQuotedValue(
      normalizedError,
      /not_found:\s*handle\s+([^\s"'}]+)\s+not found,\s*must be one of/i,
    );
  if (modelHandle) {
    return {
      kind: "model_handle_not_found",
      message: `Model handle "${modelHandle}" was not found.`,
    };
  }

  return undefined;
}

export function isRetryableReflectionArenaModelError(
  error: string | undefined,
): boolean {
  if (!error || classifyReflectionConfigurationError(error)) return false;
  const normalized = error.toLowerCase();
  return [
    "not-enough-credits",
    "no credits",
    "out of credits",
    "insufficient credits",
    "exceeded-quota",
    "llm_insufficient_credits",
  ].some((marker) => normalized.includes(marker));
}
