import { connectMcpServer } from "@/mcp-client";
import {
  createMcpOAuthSessionWithStorage,
  type McpOAuthCredentialSnapshot,
  type McpOAuthStorage,
  mcpOAuthCredentialKey,
} from "@/mcp-oauth";

export type { McpOAuthCredentialSnapshot, McpOAuthStorage } from "@/mcp-oauth";

/** Options for one complete, single-flight MCP OAuth authorization. */
export interface AuthorizeMcpServerWithStorageOptions {
  /** Owning agent used to namespace the storage key. */
  agentId: string;
  storage: McpOAuthStorage;
  serverName: string;
  serverUrl: string;
  openBrowser?: (url: string) => Promise<void>;
  onStatus?: (message: string) => void;
  signal?: AbortSignal;
}

/**
 * Authorize and validate one HTTP MCP server, then return importable credentials.
 *
 * The low-level OAuth provider is intentionally not part of this package
 * subpath's public surface. One call owns one SDK authorization lifecycle;
 * callers start another call rather than overlapping auth operations on one
 * provider instance. The storage key is derived from the owning agent plus the
 * server name and URL, and cross-call access is coordinated and version-fenced
 * by the underlying storage implementation.
 */
export async function authorizeMcpServerWithStorage(
  options: AuthorizeMcpServerWithStorageOptions,
): Promise<McpOAuthCredentialSnapshot> {
  if (options.signal?.aborted) {
    throw new Error("MCP OAuth flow was cancelled");
  }
  const oauth = await createMcpOAuthSessionWithStorage({
    credentialKey: mcpOAuthCredentialKey(
      options.agentId,
      options.serverName,
      options.serverUrl,
    ),
    storage: options.storage,
    interactive: true,
    openBrowser: options.openBrowser,
    onStatus: options.onStatus,
  });
  if (!oauth) throw new Error("MCP OAuth session was not created");

  let connection: Awaited<ReturnType<typeof connectMcpServer>> | undefined;
  const cancel = () => {
    void oauth.close();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    connection = await connectMcpServer(
      {
        name: options.serverName,
        transport: "http",
        url: options.serverUrl,
      },
      { oauth },
    );
    if (options.signal?.aborted) {
      throw new Error("MCP OAuth flow was cancelled");
    }
    return await oauth.exportCredentials();
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    await Promise.allSettled([connection?.close(), oauth.close()]);
  }
}
