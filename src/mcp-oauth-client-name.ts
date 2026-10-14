/** `client_name` sent to a provider's dynamic client registration by default. */
export const DEFAULT_MCP_OAUTH_CLIENT_NAME = "Letta Code";
const MAX_MCP_OAUTH_CLIENT_NAME_LENGTH = 64;

/**
 * Validate an optional consent-screen client name and apply the default.
 * Throws on an empty or over-long name so a bad value fails before the browser
 * flow starts rather than reaching the provider.
 */
export function resolveMcpOAuthClientName(clientName?: string): string {
  if (clientName === undefined) return DEFAULT_MCP_OAUTH_CLIENT_NAME;
  const trimmed = clientName.trim();
  if (!trimmed) throw new Error("MCP OAuth client name must not be empty");
  if (trimmed.length > MAX_MCP_OAUTH_CLIENT_NAME_LENGTH) {
    throw new Error(
      `MCP OAuth client name must be at most ${MAX_MCP_OAUTH_CLIENT_NAME_LENGTH} characters`,
    );
  }
  return trimmed;
}
