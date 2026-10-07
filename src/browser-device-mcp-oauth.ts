import { createHash, randomUUID } from "node:crypto";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { apiRequest } from "@/backend/api/request";
import {
  type AuthorizeMcpServerWithStorageOptions,
  authorizeMcpServerWithStorage,
  type McpOAuthCredentialSnapshot,
  type McpOAuthFetch,
  type McpOAuthStorage,
} from "@/mcp-oauth-public";

export interface BrowserDeviceMcpOAuthRequest {
  handoffKey: string;
  service: string;
  serverUrl: string;
}

interface BrowserDeviceMcpOAuthDefinition {
  authorizationOrigins: readonly string[];
  serverName: string;
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

const HANDOFF_KEY_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

const BROWSER_DEVICE_MCP_OAUTH_SERVICES: Record<
  string,
  readonly BrowserDeviceMcpOAuthDefinition[]
> = {
  comfy: [
    {
      authorizationOrigins: ["https://cloud.comfy.org"],
      serverName: "Comfy Cloud",
      serverUrl: "https://cloud.comfy.org/mcp",
    },
  ],
  datadog: [
    datadogDefinition("datadoghq.com", "app.datadoghq.com"),
    datadogDefinition("us3.datadoghq.com", "us3.datadoghq.com"),
    datadogDefinition("us5.datadoghq.com", "us5.datadoghq.com"),
    datadogDefinition("datadoghq.eu", "app.datadoghq.eu"),
    datadogDefinition("ap1.datadoghq.com", "ap1.datadoghq.com"),
    datadogDefinition("ap2.datadoghq.com", "ap2.datadoghq.com"),
    datadogDefinition("uk1.datadoghq.com", "uk1.datadoghq.com"),
  ],
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
    importCredentials: submitBrowserDeviceMcpOAuthHandoff,
    openBrowser: openSystemBrowser,
  },
): Promise<void> {
  const definition = resolveDefinition(request);
  const canonicalRequest = { ...request, serverUrl: definition.serverUrl };
  const ephemeralStorage = createEphemeralStorage();
  try {
    const credentials = await dependencies.authorize({
      agentId: handoffNamespace(request.handoffKey),
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
    new URL(definition.serverUrl).origin,
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
): BrowserDeviceMcpOAuthDefinition {
  if (!HANDOFF_KEY_PATTERN.test(request.handoffKey)) {
    throw new BrowserDeviceMcpOAuthRequestError("Invalid OAuth handoff key");
  }
  const definitions = BROWSER_DEVICE_MCP_OAUTH_SERVICES[request.service];
  if (!definitions) {
    throw new BrowserDeviceMcpOAuthRequestError(
      "Unsupported localhost OAuth service",
    );
  }
  const requestedUrl = normalizeServerUrl(request.serverUrl);
  const definition = definitions.find(
    (candidate) => normalizeServerUrl(candidate.serverUrl) === requestedUrl,
  );
  if (!definition) {
    throw new BrowserDeviceMcpOAuthRequestError(
      "Unsupported localhost OAuth server URL",
    );
  }
  return definition;
}

export function canonicalizeBrowserDeviceMcpOAuthRequest(
  request: BrowserDeviceMcpOAuthRequest,
): BrowserDeviceMcpOAuthRequest {
  const definition = resolveDefinition(request);
  return { ...request, serverUrl: definition.serverUrl };
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

export async function submitBrowserDeviceMcpOAuthHandoff(
  request: BrowserDeviceMcpOAuthRequest,
  credentials: McpOAuthCredentialSnapshot,
): Promise<void> {
  const response = await apiRequest<{
    authorized?: unknown;
    connected?: unknown;
  }>(
    "POST",
    "/v1/tools/mcp/browser-device-oauth/handoffs",
    { ...credentials, handoff_key: request.handoffKey },
    {
      actingUserId: null,
      apiKey: "",
      baseUrl: LETTA_CLOUD_API_URL,
      signal: AbortSignal.timeout(90_000),
    },
  );
  if (response.authorized !== true || response.connected !== true) {
    throw new Error("Cloud did not confirm the MCP OAuth connection");
  }
}

function datadogDefinition(
  mcpHost: string,
  appHost: string,
): BrowserDeviceMcpOAuthDefinition {
  return {
    authorizationOrigins: [`https://${appHost}`],
    serverName: "Datadog",
    serverUrl: `https://mcp.${mcpHost}/v1/mcp`,
  };
}

function handoffNamespace(handoffKey: string): string {
  const digest = createHash("sha256").update(handoffKey).digest("hex");
  return `browser-device-${digest.slice(0, 32)}`;
}

async function openSystemBrowser(url: string): Promise<void> {
  const { default: open } = await import("open");
  const subprocess = await open(url, { wait: false });
  subprocess.on("error", () => undefined);
}
