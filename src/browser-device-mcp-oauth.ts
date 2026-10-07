import { randomUUID } from "node:crypto";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { apiRequest, getApiRequestConfig } from "@/backend/api/request";
import {
  type AuthorizeMcpServerWithStorageOptions,
  authorizeMcpServerWithStorage,
  type McpOAuthCredentialSnapshot,
  type McpOAuthFetch,
  type McpOAuthStorage,
} from "@/mcp-oauth-public";

export interface BrowserDeviceMcpOAuthRequest {
  agentId: string;
  service: string;
  serverUrl: string;
}

interface BrowserDeviceMcpOAuthDefinition {
  authorizationOrigins: readonly string[];
  serverName: string;
  serverUrls: readonly string[];
}

interface ResolvedBrowserDeviceMcpOAuthDefinition
  extends BrowserDeviceMcpOAuthDefinition {
  serverUrl: string;
}

interface BrowserDeviceMcpOAuthDependencies {
  authorize: (
    options: AuthorizeMcpServerWithStorageOptions,
  ) => Promise<McpOAuthCredentialSnapshot>;
  importCredentials: (
    request: BrowserDeviceMcpOAuthRequest,
    credentials: McpOAuthCredentialSnapshot,
  ) => Promise<void>;
  providerFetch?: McpOAuthFetch;
  openBrowser: (url: string) => Promise<void>;
}

const AGENT_ID_PATTERN = /^agent-[A-Za-z0-9_-]{1,128}$/;

const BROWSER_DEVICE_MCP_OAUTH_SERVICES: Record<
  string,
  BrowserDeviceMcpOAuthDefinition
> = {
  comfy: {
    authorizationOrigins: ["https://cloud.comfy.org"],
    serverName: "Comfy Cloud",
    serverUrls: ["https://cloud.comfy.org/mcp"],
  },
  datadog: {
    authorizationOrigins: [
      "https://app.datadoghq.com",
      "https://us3.datadoghq.com",
      "https://us5.datadoghq.com",
      "https://app.datadoghq.eu",
      "https://ap1.datadoghq.com",
      "https://ap2.datadoghq.com",
      "https://uk1.datadoghq.com",
    ],
    serverName: "Datadog",
    serverUrls: [
      "https://mcp.datadoghq.com/v1/mcp",
      "https://mcp.us3.datadoghq.com/v1/mcp",
      "https://mcp.us5.datadoghq.com/v1/mcp",
      "https://mcp.datadoghq.eu/v1/mcp",
      "https://mcp.ap1.datadoghq.com/v1/mcp",
      "https://mcp.ap2.datadoghq.com/v1/mcp",
      "https://mcp.uk1.datadoghq.com/v1/mcp",
    ],
  },
};

export class BrowserDeviceMcpOAuthRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserDeviceMcpOAuthRequestError";
  }
}

/**
 * Complete a Cloud agent's localhost-callback MCP authorization from a local
 * Letta Code runtime. Letta Daemon runs the same runtime, so it exposes this
 * bridge without a separate daemon-specific OAuth implementation.
 */
export async function connectBrowserDeviceMcpOAuth(
  request: BrowserDeviceMcpOAuthRequest,
  dependencies: BrowserDeviceMcpOAuthDependencies = {
    authorize: authorizeMcpServerWithStorage,
    importCredentials: importBrowserDeviceMcpOAuthCredentials,
    openBrowser: openSystemBrowser,
  },
): Promise<void> {
  const definition = resolveDefinition(request);
  const canonicalRequest = { ...request, serverUrl: definition.serverUrl };
  const ephemeralStorage = createEphemeralStorage();
  try {
    const credentials = await dependencies.authorize({
      agentId: request.agentId,
      openBrowser: async (value) => {
        const url = allowedAuthorizationUrl(
          value,
          definition.authorizationOrigins,
        );
        await dependencies.openBrowser(url.href);
      },
      fetch: createProviderFetch(
        definition,
        dependencies.providerFetch ?? globalThis.fetch,
      ),
      serverName: definition.serverName,
      serverUrl: definition.serverUrl,
      storage: ephemeralStorage.storage,
      storageNamespace: `browser-device-mcp-oauth-${randomUUID()}`,
    });
    await dependencies.importCredentials(canonicalRequest, credentials);
  } finally {
    ephemeralStorage.clear();
  }
}

function createProviderFetch(
  definition: BrowserDeviceMcpOAuthDefinition,
  baseFetch: McpOAuthFetch,
): McpOAuthFetch {
  const allowedOrigins = new Set([
    ...definition.authorizationOrigins,
    ...definition.serverUrls.map((value) => new URL(value).origin),
  ]);
  return async (input, init) => {
    const request = new Request(input.toString(), init);
    const method = request.method.toUpperCase();
    const body =
      method === "GET" || method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    let currentUrl = allowedProviderUrl(request.url, allowedOrigins);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      const response = await baseFetch(currentUrl, {
        body,
        headers: request.headers,
        method,
        redirect: "manual",
        signal: request.signal,
      });
      if (response.status < 300 || response.status >= 400) return response;
      await response.body?.cancel();
      if (method !== "GET" && method !== "HEAD") {
        throw new Error("OAuth provider POST redirects are not allowed");
      }
      if (redirects === 3) {
        throw new Error("OAuth provider returned too many redirects");
      }
      const location = response.headers.get("location");
      if (!location) {
        throw new Error("OAuth provider redirect is missing a location");
      }
      const nextUrl = allowedProviderUrl(
        new URL(location, currentUrl).href,
        allowedOrigins,
      );
      if (nextUrl.origin !== currentUrl.origin) {
        throw new Error(
          "Cross-origin OAuth provider redirects are not allowed",
        );
      }
      currentUrl = nextUrl;
    }
    throw new Error("OAuth provider returned too many redirects");
  };
}

function allowedProviderUrl(value: string, allowedOrigins: Set<string>): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OAuth provider returned an invalid URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedOrigins.has(url.origin)
  ) {
    throw new Error("OAuth provider URL is not allowed");
  }
  return url;
}

function resolveDefinition(
  request: BrowserDeviceMcpOAuthRequest,
): ResolvedBrowserDeviceMcpOAuthDefinition {
  if (!AGENT_ID_PATTERN.test(request.agentId)) {
    throw new BrowserDeviceMcpOAuthRequestError("Invalid agent ID");
  }
  const definition = BROWSER_DEVICE_MCP_OAUTH_SERVICES[request.service];
  if (!definition) {
    throw new BrowserDeviceMcpOAuthRequestError(
      "Unsupported localhost OAuth service",
    );
  }
  const requestedUrl = normalizeServerUrl(request.serverUrl);
  const selectedUrl = definition.serverUrls.find(
    (candidate) => normalizeServerUrl(candidate) === requestedUrl,
  );
  if (!selectedUrl) {
    throw new BrowserDeviceMcpOAuthRequestError(
      "Unsupported localhost OAuth server URL",
    );
  }
  return { ...definition, serverUrl: selectedUrl };
}

function normalizeServerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BrowserDeviceMcpOAuthRequestError("Invalid MCP server URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new BrowserDeviceMcpOAuthRequestError("Invalid MCP server URL");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.href;
}

function allowedAuthorizationUrl(
  value: string,
  allowedOrigins: readonly string[],
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("OAuth provider returned an invalid authorization URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new Error("OAuth authorization origin is not allowed");
  }
  return url;
}

function createEphemeralStorage(): {
  storage: McpOAuthStorage;
  clear: () => void;
} {
  const values = new Map<string, string>();
  return {
    storage: {
      delete: async (credentialKey, signal) => {
        signal.throwIfAborted();
        return values.delete(credentialKey);
      },
      get: async (credentialKey, signal) => {
        signal.throwIfAborted();
        return values.get(credentialKey) ?? null;
      },
      set: async (credentialKey, value, signal) => {
        signal.throwIfAborted();
        values.set(credentialKey, value);
      },
    },
    clear: () => values.clear(),
  };
}

async function importBrowserDeviceMcpOAuthCredentials(
  request: BrowserDeviceMcpOAuthRequest,
  credentials: McpOAuthCredentialSnapshot,
): Promise<void> {
  const { apiKey } = await getApiRequestConfig();
  if (!apiKey) throw new Error("Letta Cloud authentication is unavailable");
  const response = await apiRequest<{
    authorized?: unknown;
    connected?: unknown;
  }>(
    "PUT",
    `/v1/agents/${encodeURIComponent(request.agentId)}/mcp-connections/${encodeURIComponent(request.service)}/oauth-credentials`,
    { ...credentials, server_url: request.serverUrl },
    { apiKey, baseUrl: LETTA_CLOUD_API_URL },
  );
  if (response.authorized !== true || response.connected !== true) {
    throw new Error("Cloud did not confirm the MCP OAuth connection");
  }
}

async function openSystemBrowser(url: string): Promise<void> {
  const { default: open } = await import("open");
  const subprocess = await open(url, { wait: false });
  subprocess.on("error", () => undefined);
}
