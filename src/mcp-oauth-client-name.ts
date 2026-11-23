export const DEFAULT_MCP_OAUTH_CLIENT_NAME = "Letta Code";
const MAX_MCP_OAUTH_CLIENT_NAME_LENGTH = 64;

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
