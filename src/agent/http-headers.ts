import packageJson from "../../package.json";

export type LettaCodeHeaderOptions = {
  baggage?: string;
};

export type LettaCodeBaggageValues = Record<string, string | undefined | null>;

export function buildW3CBaggageHeader(
  values: LettaCodeBaggageValues,
): string | undefined {
  const entries = Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .map(([key, value]) => `${key}=${encodeURIComponent(value as string)}`);

  return entries.length > 0 ? entries.join(",") : undefined;
}

export function mergeW3CBaggageHeaders(
  existingBaggage: string | undefined,
  values: LettaCodeBaggageValues,
): string | undefined {
  const nextBaggage = buildW3CBaggageHeader(values);
  if (!existingBaggage) {
    return nextBaggage;
  }
  if (!nextBaggage) {
    return existingBaggage;
  }
  return `${existingBaggage},${nextBaggage}`;
}

export function getLettaCodeDefaultHeaders(
  options: LettaCodeHeaderOptions = {},
): Record<string, string> {
  return {
    "User-Agent": `letta-code/${packageJson.version}`,
    "X-Letta-Source": "letta-code",
    ...(options.baggage ? { baggage: options.baggage } : {}),
  };
}

/**
 * Get standard headers for manual HTTP calls to Letta API.
 * Use this for any direct fetch() calls (not SDK calls).
 */
export function getLettaCodeHeaders(
  apiKey?: string,
  options: LettaCodeHeaderOptions = {},
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...getLettaCodeDefaultHeaders(options),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/**
 * Get headers for MCP OAuth connections (includes Accept header for SSE).
 */
export function getMcpOAuthHeaders(apiKey: string): Record<string, string> {
  return {
    ...getLettaCodeHeaders(apiKey),
    Accept: "text/event-stream",
  };
}
