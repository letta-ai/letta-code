import { createHash } from "node:crypto";

export function mcpOAuthCredentialKey(
  agentId: string,
  serverName: string,
  serverUrl: string,
): string {
  return hashMcpOAuthCredentialKey(
    agentId,
    serverName,
    normalizeMcpServerUrl(serverUrl),
  );
}

function hashMcpOAuthCredentialKey(
  agentId: string,
  serverName: string,
  serverUrl: string,
): string {
  const digest = createHash("sha256")
    .update(`${agentId}\0${serverName}\0${serverUrl}`)
    .digest("hex")
    .slice(0, 32);
  return `mcp-oauth-${digest}`;
}

function normalizeMcpServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    if (url.pathname !== "/") return url.href;
    const suffix = url.search + url.hash;
    return url.href.slice(0, url.href.length - suffix.length - 1) + suffix;
  } catch {
    return serverUrl;
  }
}

export function legacyMcpOAuthCredentialKeys(
  agentId: string,
  serverName: string,
  serverUrl: string,
): string[] {
  const variants = [serverUrl];
  try {
    variants.push(new URL(serverUrl).href);
  } catch {}
  const current = mcpOAuthCredentialKey(agentId, serverName, serverUrl);
  return [
    ...new Set(
      variants.map((url) =>
        hashMcpOAuthCredentialKey(agentId, serverName, url),
      ),
    ),
  ].filter((key) => key !== current);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

export function hasMatchingRedirectUri(
  registered: readonly string[],
  redirectUrl: string,
): boolean {
  return registered.some((candidate) => {
    if (candidate === redirectUrl) return true;
    try {
      const expected = new URL(redirectUrl);
      const actual = new URL(candidate);
      if (
        expected.protocol !== "http:" ||
        !LOOPBACK_HOSTS.has(expected.hostname)
      ) {
        return false;
      }
      expected.port = "";
      actual.port = "";
      return actual.href === expected.href;
    } catch {
      return false;
    }
  });
}
