import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  deleteSecretValue,
  getSecretValue,
  setSecretValue,
} from "@/utils/secrets";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

interface PersistedMcpOAuthState {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

export interface McpOAuthSession {
  authProvider: OAuthClientProvider;
  waitForAuthorizationCode?: () => Promise<string>;
  close(): Promise<void>;
}

export interface McpOAuthSessionOptions {
  interactive: boolean;
  onStatus?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void>;
}

export async function clearMcpOAuthCredentials(
  agentId: string,
  serverName: string,
  serverUrl: string,
): Promise<boolean> {
  return deleteSecretValue(oauthSecretName(agentId, serverName, serverUrl));
}

export async function createMcpOAuthSession(
  agentId: string,
  serverName: string,
  serverUrl: string,
  options: McpOAuthSessionOptions,
): Promise<McpOAuthSession | undefined> {
  const secretName = oauthSecretName(agentId, serverName, serverUrl);
  const persisted = await loadState(secretName);
  if (!options.interactive && !persisted) return undefined;

  const callback = options.interactive
    ? await startOAuthCallbackServer(callbackPort(persisted?.redirectUrl))
    : undefined;
  const redirectUrl = callback?.redirectUrl ?? persisted?.redirectUrl;
  if (!redirectUrl) return undefined;

  const provider = new PersistentMcpOAuthProvider({
    secretName,
    redirectUrl,
    persisted,
    interactive: options.interactive,
    onStatus: options.onStatus,
    openBrowser: options.openBrowser ?? openSystemBrowser,
    expectedState: callback?.expectedState,
  });

  return {
    authProvider: provider,
    ...(callback
      ? { waitForAuthorizationCode: () => callback.waitForCode() }
      : {}),
    close: async () => callback?.close(),
  };
}

class PersistentMcpOAuthProvider implements OAuthClientProvider {
  private stateData: PersistedMcpOAuthState;
  private readonly secretName: string;
  private readonly interactive: boolean;
  private readonly onStatus?: (message: string) => void;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly expectedState?: { value?: string };

  constructor(options: {
    secretName: string;
    redirectUrl: string;
    persisted?: PersistedMcpOAuthState;
    interactive: boolean;
    onStatus?: (message: string) => void;
    openBrowser: (url: string) => Promise<void>;
    expectedState?: { value?: string };
  }) {
    this.secretName = options.secretName;
    this.interactive = options.interactive;
    this.onStatus = options.onStatus;
    this.openBrowser = options.openBrowser;
    this.expectedState = options.expectedState;
    this.stateData = {
      ...options.persisted,
      redirectUrl: options.redirectUrl,
    };
  }

  get redirectUrl(): string {
    return this.stateData.redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Letta Code",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    const state = randomBytes(24).toString("base64url");
    if (this.expectedState) this.expectedState.value = state;
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const client = this.stateData.clientInformation;
    return client &&
      "redirect_uris" in client &&
      client.redirect_uris.includes(this.redirectUrl)
      ? client
      : undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    this.stateData.clientInformation = clientInformation;
  }

  tokens(): OAuthTokens | undefined {
    return this.stateData.tokens;
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stateData.tokens = tokens;
    delete this.stateData.codeVerifier;
    await this.persist();
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    if (!this.interactive) {
      throw new Error(
        "MCP authentication requires user authorization. Open /mcp and press R to sign in.",
      );
    }
    this.onStatus?.(
      `Opening browser to authorize MCP server.\nIf it does not open, visit:\n${authorizationUrl.toString()}`,
    );
    await this.openBrowser(authorizationUrl.toString());
  }

  saveCodeVerifier(codeVerifier: string): void {
    this.stateData.codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.stateData.codeVerifier) {
      throw new Error("No MCP OAuth PKCE verifier is available");
    }
    return this.stateData.codeVerifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.stateData.discoveryState = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.stateData.discoveryState;
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "all") {
      this.stateData = { redirectUrl: this.redirectUrl };
      await deleteSecretValue(this.secretName);
      return;
    }
    if (scope === "client") delete this.stateData.clientInformation;
    if (scope === "tokens") delete this.stateData.tokens;
    if (scope === "verifier") delete this.stateData.codeVerifier;
    if (scope === "discovery") delete this.stateData.discoveryState;
    await this.persist();
  }

  private async persist(): Promise<void> {
    await setSecretValue(this.secretName, JSON.stringify(this.stateData));
  }
}

interface OAuthCallbackServer {
  redirectUrl: string;
  expectedState: { value?: string };
  waitForCode(): Promise<string>;
  close(): void;
}

async function startOAuthCallbackServer(
  preferredPort?: number,
): Promise<OAuthCallbackServer> {
  try {
    return await startOAuthCallbackServerOnPort(preferredPort ?? 0);
  } catch (error) {
    if (!preferredPort) throw error;
    return startOAuthCallbackServerOnPort(0);
  }
}

async function startOAuthCallbackServerOnPort(
  port: number,
): Promise<OAuthCallbackServer> {
  const expectedState: { value?: string } = {};
  let server: Server;
  let completed = false;
  let settle: ((code: string) => void) | undefined;
  let reject: ((error: Error) => void) | undefined;
  const codePromise = new Promise<string>((resolve, rejectPromise) => {
    settle = (code) => {
      completed = true;
      resolve(code);
    };
    reject = (error) => {
      completed = true;
      rejectPromise(error);
    };
  });
  void codePromise.catch(() => undefined);

  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end("Not found");
      return;
    }
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (error) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(callbackPage("Authorization failed", error));
      reject?.(new Error(`MCP OAuth authorization failed: ${error}`));
      server.close();
      return;
    }
    if (!code || !state || state !== expectedState.value) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(
        callbackPage("Authorization failed", "Invalid OAuth callback"),
      );
      reject?.(new Error("Invalid MCP OAuth callback state"));
      server.close();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end(
      callbackPage(
        "Authorization complete",
        "You can close this tab and return to Letta Code.",
      ),
    );
    settle?.(code);
    server.close();
  });

  await new Promise<void>((resolve, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolve);
  });
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not start MCP OAuth callback server");
  }
  const timeout = setTimeout(() => {
    reject?.(new Error("Timed out waiting for MCP OAuth authorization"));
    server.close();
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    expectedState,
    waitForCode: () => codePromise.finally(() => clearTimeout(timeout)),
    close: () => {
      clearTimeout(timeout);
      if (!completed) reject?.(new Error("MCP OAuth flow was cancelled"));
      server.close();
    },
  };
}

function callbackPort(redirectUrl?: string): number | undefined {
  if (!redirectUrl) return undefined;
  try {
    const parsed = new URL(redirectUrl);
    return parsed.hostname === "127.0.0.1" && parsed.port
      ? Number(parsed.port)
      : undefined;
  } catch {
    return undefined;
  }
}

function callbackPage(title: string, message: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;padding:2rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character] ?? character;
  });
}

async function openSystemBrowser(url: string): Promise<void> {
  try {
    const { default: open } = await import("open");
    const subprocess = await open(url, { wait: false });
    subprocess.on("error", () => {});
  } catch {
    // The authorization URL is also printed in the command status.
  }
}

function oauthSecretName(
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

async function loadState(
  secretName: string,
): Promise<PersistedMcpOAuthState | undefined> {
  const value = await getSecretValue(secretName, "MCP OAuth credentials");
  if (!value) return undefined;
  try {
    return JSON.parse(value) as PersistedMcpOAuthState;
  } catch {
    await deleteSecretValue(secretName);
    return undefined;
  }
}
