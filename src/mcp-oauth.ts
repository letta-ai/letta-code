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
  tokenExpiresAt?: number;
  codeVerifier?: string;
  discoveryState?: OAuthDiscoveryState;
}

/** Credentials produced by a completed MCP OAuth flow. */
export interface McpOAuthCredentialSnapshot {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  client_secret?: string;
  redirect_uri: string;
  token_type?: string;
  /** Remaining access-token lifetime in seconds at export time. */
  expires_in?: number;
  scope?: string;
}

export interface McpOAuthSession {
  authProvider: OAuthClientProvider;
  waitForAuthorizationCode?: () => Promise<string>;
  close(): Promise<void>;
}

export interface ExportableMcpOAuthSession extends McpOAuthSession {
  /** Export credentials after the MCP client finishes authorization. */
  exportCredentials(): McpOAuthCredentialSnapshot;
}

/** Async storage for opaque serialized MCP OAuth state. */
export interface McpOAuthStorage {
  get(credentialKey: string): Promise<string | null | undefined>;
  set(credentialKey: string, value: string): Promise<void>;
  delete(credentialKey: string): Promise<unknown>;
}

export interface McpOAuthSessionOptions {
  interactive: boolean;
  onStatus?: (message: string) => void;
  openBrowser?: (url: string) => Promise<void>;
}

export interface StorageInjectedMcpOAuthSessionOptions {
  /** Consumer-owned opaque key used for every storage operation. */
  credentialKey: string;
  storage: McpOAuthStorage;
  interactive: boolean;
  openBrowser?: (url: string) => Promise<void>;
  onStatus?: (message: string) => void;
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
  const credentialKey = oauthSecretName(agentId, serverName, serverUrl);
  return createMcpOAuthSessionWithStorage({
    credentialKey,
    storage: bunSecretStorage,
    interactive: options.interactive,
    onStatus: options.onStatus,
    openBrowser: options.openBrowser ?? openSystemBrowser,
  });
}

export async function createMcpOAuthSessionWithStorage(
  options: StorageInjectedMcpOAuthSessionOptions,
): Promise<ExportableMcpOAuthSession | undefined> {
  const persisted = await loadState(options.storage, options.credentialKey);
  if (!options.interactive && !persisted) return undefined;

  const callback = options.interactive
    ? await startOAuthCallbackServer(callbackPort(persisted?.redirectUrl))
    : undefined;
  const redirectUrl = callback?.redirectUrl ?? persisted?.redirectUrl;
  if (!redirectUrl) return undefined;

  const provider = new PersistentMcpOAuthProvider({
    credentialKey: options.credentialKey,
    storage: options.storage,
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
    exportCredentials: () => provider.exportCredentials(),
    close: async () => callback?.close(),
  };
}

const bunSecretStorage: McpOAuthStorage = {
  get: (credentialKey) =>
    getSecretValue(credentialKey, "MCP OAuth credentials"),
  set: setSecretValue,
  delete: deleteSecretValue,
};

class PersistentMcpOAuthProvider implements OAuthClientProvider {
  private stateData: PersistedMcpOAuthState;
  private storageMutation = Promise.resolve();
  private readonly credentialKey: string;
  private readonly storage: McpOAuthStorage;
  private readonly interactive: boolean;
  private readonly onStatus?: (message: string) => void;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly expectedState?: { value?: string };

  constructor(options: {
    credentialKey: string;
    storage: McpOAuthStorage;
    redirectUrl: string;
    persisted?: PersistedMcpOAuthState;
    interactive: boolean;
    onStatus?: (message: string) => void;
    openBrowser: (url: string) => Promise<void>;
    expectedState?: { value?: string };
  }) {
    this.credentialKey = options.credentialKey;
    this.storage = options.storage;
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

  exportCredentials(): McpOAuthCredentialSnapshot {
    const clientInformation = this.clientInformation();
    const tokens = this.tokens();
    if (!clientInformation?.client_id || !tokens?.access_token) {
      throw new Error("MCP OAuth authorization is not complete");
    }

    return {
      access_token: tokens.access_token,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      client_id: clientInformation.client_id,
      ...(clientInformation.client_secret
        ? { client_secret: clientInformation.client_secret }
        : {}),
      redirect_uri: this.redirectUrl,
      ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
      ...(this.stateData.tokenExpiresAt !== undefined
        ? {
            expires_in: Math.max(
              0,
              Math.ceil((this.stateData.tokenExpiresAt - Date.now()) / 1000),
            ),
          }
        : {}),
      ...(tokens.scope ? { scope: tokens.scope } : {}),
    };
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.stateData.tokens = {
      ...tokens,
      refresh_token:
        tokens.refresh_token ?? this.stateData.tokens?.refresh_token,
    };
    this.stateData.tokenExpiresAt =
      tokens.expires_in === undefined
        ? undefined
        : Date.now() + tokens.expires_in * 1000;
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
      await this.enqueueStorageMutation(async () => {
        await this.storage.delete(this.credentialKey);
      });
      return;
    }
    if (scope === "client") delete this.stateData.clientInformation;
    if (scope === "tokens") delete this.stateData.tokens;
    if (scope === "verifier") delete this.stateData.codeVerifier;
    if (scope === "discovery") delete this.stateData.discoveryState;
    await this.persist();
  }

  private async persist(): Promise<void> {
    const value = JSON.stringify(this.stateData);
    await this.enqueueStorageMutation(() =>
      this.storage.set(this.credentialKey, value),
    );
  }

  private enqueueStorageMutation(mutation: () => Promise<void>): Promise<void> {
    const pending = this.storageMutation.then(mutation, mutation);
    this.storageMutation = pending.catch(() => undefined);
    return pending;
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
    if (!state || state !== expectedState.value) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(
        callbackPage("Authorization failed", "Invalid OAuth callback"),
      );
      return;
    }
    if (error) {
      response.writeHead(400, { "Content-Type": "text/html" });
      reject?.(new Error(`MCP OAuth authorization failed: ${error}`));
      response.end(callbackPage("Authorization failed", error), () => {
        void closeServer(true);
      });
      return;
    }
    if (!code) {
      response.writeHead(400, { "Content-Type": "text/html" });
      response.end(
        callbackPage("Authorization failed", "Missing authorization code"),
      );
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html" });
    settle?.(code);
    response.end(
      callbackPage(
        "Authorization complete",
        "You can close this tab and return to Letta Code.",
      ),
      () => {
        void closeServer(true);
      },
    );
  });

  let serverClosing = false;
  const closeServer = (force = false): void => {
    if (serverClosing) return;
    serverClosing = true;
    server.close();
    if (force) server.closeAllConnections();
  };

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
    void closeServer(true);
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  return {
    redirectUrl: `http://127.0.0.1:${address.port}/callback`,
    expectedState,
    waitForCode: () => codePromise.finally(() => clearTimeout(timeout)),
    close: () => {
      clearTimeout(timeout);
      if (!completed) reject?.(new Error("MCP OAuth flow was cancelled"));
      closeServer(true);
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
  storage: McpOAuthStorage,
  credentialKey: string,
): Promise<PersistedMcpOAuthState | undefined> {
  const value = await storage.get(credentialKey);
  if (!value) return undefined;
  try {
    return JSON.parse(value) as PersistedMcpOAuthState;
  } catch {
    await storage.delete(credentialKey);
    return undefined;
  }
}
