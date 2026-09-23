import packageJson from "../../../package.json";

/**
 * Get standard headers for manual HTTP calls to Letta API.
 * Use this for any direct fetch() calls (not SDK calls).
 */
export function getLettaCodeHeaders(
  apiKey?: string,
  actingUserId = process.env.LETTA_ACTING_USER_ID,
): Record<string, string> {
  const normalizedActingUserId = actingUserId?.trim();
  return {
    "Content-Type": "application/json",
    "User-Agent": `letta-code/${packageJson.version}`,
    "X-Letta-Source": "letta-code",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(normalizedActingUserId
      ? { "X-Letta-Acting-User-Id": normalizedActingUserId }
      : {}),
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
