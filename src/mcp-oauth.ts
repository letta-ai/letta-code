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
  OAuthClientInformationFullSchema,
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
  SafeUrlSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  deleteSecretValue,
  getSecretValue,
  setSecretValue,
} from "@/utils/secrets";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;
const credentialCoordinators = new Map<string, CredentialCoordinator>();

interface CredentialCoordinator {
  queue: Promise<void>;
  generation: number;
  state?: PersistedMcpOAuthState;
  clientVersion: number;
  tokenVersion: number;
  discoveryVersion: number;
}

interface PersistedMcpOAuthState {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  tokenExpiresAt?: number;
  discoveryState?: OAuthDiscoveryState;
}

interface PendingField<T> {
  value: T;
  baseVersion: number;
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
  exportCredentials(): Promise<McpOAuthCredentialSnapshot>;
}

/**
 * Async storage for completed MCP OAuth credentials.
 *
 * Discovery, dynamic registration, and PKCE verifier state remain scoped to an
 * active callback session and are committed together only after token exchange;
 * an interrupted browser flow starts over rather than attempting callback
 * recovery without its original loopback listener.
 */
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
  /** Consumer-owned opaque key, unique process-wide across storage backends. */
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
  const credentialKey = mcpOAuthCredentialKey(agentId, serverName, serverUrl);
  const { result } = await clearStoredCredentials(
    bunSecretStorage,
    credentialKey,
  );
  return result === true;
}

export async function createMcpOAuthSession(
  agentId: string,
  serverName: string,
  serverUrl: string,
  options: McpOAuthSessionOptions,
): Promise<McpOAuthSession | undefined> {
  const credentialKey = mcpOAuthCredentialKey(agentId, serverName, serverUrl);
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
  const loaded = await loadState(options.storage, options.credentialKey);
  const persisted = loaded.state;
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
    generation: loaded.generation,
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
  private pendingClientInformation?: PendingField<OAuthClientInformationMixed>;
  private pendingDiscoveryState?: PendingField<OAuthDiscoveryState>;
  private codeVerifierValue?: string;
  private generation: number;
  private observedClientVersion: number;
  private observedTokenVersion: number;
  private observedDiscoveryVersion: number;
  private tokenOperationGeneration: number;
  private tokenOperationVersion: number;
  private readonly coordinator: CredentialCoordinator;
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
    generation: number;
  }) {
    this.credentialKey = options.credentialKey;
    this.storage = options.storage;
    this.interactive = options.interactive;
    this.onStatus = options.onStatus;
    this.openBrowser = options.openBrowser;
    this.expectedState = options.expectedState;
    this.generation = options.generation;
    this.coordinator = getCredentialCoordinator(options.credentialKey);
    this.observedClientVersion = this.coordinator.clientVersion;
    this.observedTokenVersion = this.coordinator.tokenVersion;
    this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
    this.tokenOperationGeneration = this.coordinator.generation;
    this.tokenOperationVersion = this.coordinator.tokenVersion;
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
    if (this.generation !== this.coordinator.generation) return undefined;
    if (
      this.pendingClientInformation &&
      this.pendingClientInformation.baseVersion !==
        this.coordinator.clientVersion
    ) {
      this.pendingClientInformation = undefined;
    }
    const client =
      this.pendingClientInformation?.value ??
      this.coordinator.state?.clientInformation;
    this.observedClientVersion = this.coordinator.clientVersion;
    return client &&
      "redirect_uris" in client &&
      Array.isArray(client.redirect_uris) &&
      client.redirect_uris.includes(this.redirectUrl)
      ? client
      : undefined;
  }

  saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
    assertCurrentGeneration(this.credentialKey, this.generation);
    this.stateData.clientInformation = clientInformation;
    this.pendingClientInformation = {
      value: clientInformation,
      baseVersion: this.coordinator.clientVersion,
    };
    if (!this.coordinator.state?.tokens) {
      this.tokenOperationGeneration = this.coordinator.generation;
      this.tokenOperationVersion = this.coordinator.tokenVersion;
    }
  }

  tokens(): OAuthTokens | undefined {
    if (this.generation !== this.coordinator.generation) return undefined;
    this.observedTokenVersion = this.coordinator.tokenVersion;
    this.tokenOperationGeneration = this.coordinator.generation;
    this.tokenOperationVersion = this.coordinator.tokenVersion;
    return this.coordinator.state?.tokens;
  }

  async exportCredentials(): Promise<McpOAuthCredentialSnapshot> {
    const expectedGeneration = this.generation;
    return enqueueStorageMutation(this.credentialKey, async () => {
      assertCurrentGeneration(this.credentialKey, expectedGeneration);
      const latest = await readStoredState(this.storage, this.credentialKey);
      if (!latest) {
        throw new Error("MCP OAuth authorization is not complete");
      }
      this.coordinator.state = latest;
      this.stateData = latest;
      return exportCredentialSnapshot(latest);
    });
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    const expectedGeneration = this.tokenOperationGeneration;
    const expectedTokenVersion = this.tokenOperationVersion;
    const tokenExpiresAt =
      tokens.expires_in === undefined
        ? undefined
        : Date.now() + tokens.expires_in * 1000;
    const pendingClientInformation = this.pendingClientInformation;
    const pendingDiscoveryState = this.pendingDiscoveryState;
    const result = await enqueueStorageMutation(
      this.credentialKey,
      async () => {
        assertCurrentGeneration(this.credentialKey, expectedGeneration);
        if (this.coordinator.tokenVersion !== expectedTokenVersion) {
          throw new Error(
            "MCP OAuth token response is stale because credentials changed",
          );
        }
        if (
          (pendingClientInformation &&
            this.coordinator.clientVersion !==
              pendingClientInformation.baseVersion) ||
          (pendingDiscoveryState &&
            this.coordinator.discoveryVersion !==
              pendingDiscoveryState.baseVersion)
        ) {
          throw new Error(
            "MCP OAuth token response is stale because protocol state changed",
          );
        }
        const state =
          (await readStoredState(this.storage, this.credentialKey)) ??
          ({ redirectUrl: this.redirectUrl } satisfies PersistedMcpOAuthState);
        let clientMerged = false;
        let discoveryMerged = false;
        if (
          pendingClientInformation &&
          this.coordinator.clientVersion ===
            pendingClientInformation.baseVersion
        ) {
          state.redirectUrl = this.redirectUrl;
          state.clientInformation = pendingClientInformation.value;
          clientMerged = true;
        }
        if (
          pendingDiscoveryState &&
          this.coordinator.discoveryVersion ===
            pendingDiscoveryState.baseVersion
        ) {
          state.discoveryState = pendingDiscoveryState.value;
          discoveryMerged = true;
        }
        state.tokens = {
          ...tokens,
          refresh_token: tokens.refresh_token ?? state.tokens?.refresh_token,
        };
        state.tokenExpiresAt = tokenExpiresAt;
        await this.storage.set(this.credentialKey, JSON.stringify(state));
        this.coordinator.state = state;
        this.coordinator.tokenVersion += 1;
        if (clientMerged) this.coordinator.clientVersion += 1;
        if (discoveryMerged) this.coordinator.discoveryVersion += 1;
        return { state, clientMerged, discoveryMerged };
      },
    );
    this.stateData = result.state;
    this.observedTokenVersion = this.coordinator.tokenVersion;
    this.tokenOperationGeneration = this.coordinator.generation;
    this.tokenOperationVersion = this.coordinator.tokenVersion;
    this.observedClientVersion = this.coordinator.clientVersion;
    this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
    if (this.pendingClientInformation === pendingClientInformation) {
      this.pendingClientInformation = undefined;
    } else if (this.pendingClientInformation) {
      this.pendingClientInformation.baseVersion =
        this.coordinator.clientVersion;
    }
    if (this.pendingDiscoveryState === pendingDiscoveryState) {
      this.pendingDiscoveryState = undefined;
    } else if (this.pendingDiscoveryState) {
      this.pendingDiscoveryState.baseVersion =
        this.coordinator.discoveryVersion;
    }
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
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    if (!this.codeVerifierValue) {
      throw new Error("No MCP OAuth PKCE verifier is available");
    }
    return this.codeVerifierValue;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    assertCurrentGeneration(this.credentialKey, this.generation);
    this.stateData.discoveryState = state;
    this.pendingDiscoveryState = {
      value: state,
      baseVersion: this.coordinator.discoveryVersion,
    };
    if (!this.coordinator.state?.tokens) {
      this.tokenOperationGeneration = this.coordinator.generation;
      this.tokenOperationVersion = this.coordinator.tokenVersion;
    }
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    if (this.generation !== this.coordinator.generation) return undefined;
    if (
      this.pendingDiscoveryState &&
      this.pendingDiscoveryState.baseVersion !==
        this.coordinator.discoveryVersion
    ) {
      this.pendingDiscoveryState = undefined;
    }
    this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
    return (
      this.pendingDiscoveryState?.value ??
      this.coordinator.state?.discoveryState
    );
  }

  async invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): Promise<void> {
    if (scope === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    if (scope === "all") {
      const redirectUrl = this.redirectUrl;
      const { generation, cleared } = await clearStoredCredentials(
        this.storage,
        this.credentialKey,
        {
          generation: this.generation,
          clientVersion: this.observedClientVersion,
          tokenVersion: this.observedTokenVersion,
          discoveryVersion: this.observedDiscoveryVersion,
        },
      );
      if (!cleared) {
        this.stateData = this.coordinator.state ?? { redirectUrl };
        this.pendingClientInformation = undefined;
        this.pendingDiscoveryState = undefined;
        this.codeVerifierValue = undefined;
        this.observedClientVersion = this.coordinator.clientVersion;
        this.observedTokenVersion = this.coordinator.tokenVersion;
        this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
        return;
      }
      this.generation = generation;
      this.stateData = { redirectUrl };
      this.pendingClientInformation = undefined;
      this.pendingDiscoveryState = undefined;
      this.codeVerifierValue = undefined;
      this.observedClientVersion = this.coordinator.clientVersion;
      this.observedTokenVersion = this.coordinator.tokenVersion;
      this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
      return;
    }
    const expectedGeneration = this.generation;
    const pendingClientInformation = this.pendingClientInformation;
    const pendingDiscoveryState = this.pendingDiscoveryState;
    const expectedVersion =
      scope === "client"
        ? this.observedClientVersion
        : scope === "tokens"
          ? this.observedTokenVersion
          : this.observedDiscoveryVersion;
    const result = await enqueueStorageMutation(
      this.credentialKey,
      async () => {
        assertCurrentGeneration(this.credentialKey, expectedGeneration);
        const currentVersion =
          scope === "client"
            ? this.coordinator.clientVersion
            : scope === "tokens"
              ? this.coordinator.tokenVersion
              : this.coordinator.discoveryVersion;
        if (currentVersion !== expectedVersion) {
          return this.coordinator.state;
        }
        const state = await readStoredState(this.storage, this.credentialKey);
        if (state) {
          if (scope === "client") delete state.clientInformation;
          if (scope === "tokens") {
            delete state.tokens;
            delete state.tokenExpiresAt;
          }
          if (scope === "discovery") delete state.discoveryState;
          await this.storage.set(this.credentialKey, JSON.stringify(state));
        }
        this.coordinator.state = state;
        if (scope === "client") this.coordinator.clientVersion += 1;
        if (scope === "tokens") this.coordinator.tokenVersion += 1;
        if (scope === "discovery") this.coordinator.discoveryVersion += 1;
        return state;
      },
    );
    this.stateData = result ?? { redirectUrl: this.redirectUrl };
    if (scope === "client") {
      this.observedClientVersion = this.coordinator.clientVersion;
      if (this.pendingClientInformation === pendingClientInformation) {
        this.pendingClientInformation = undefined;
      } else if (this.pendingClientInformation) {
        this.pendingClientInformation.baseVersion =
          this.coordinator.clientVersion;
      }
    }
    if (scope === "tokens") {
      this.observedTokenVersion = this.coordinator.tokenVersion;
    }
    if (scope === "discovery") {
      this.observedDiscoveryVersion = this.coordinator.discoveryVersion;
      if (this.pendingDiscoveryState === pendingDiscoveryState) {
        this.pendingDiscoveryState = undefined;
      } else if (this.pendingDiscoveryState) {
        this.pendingDiscoveryState.baseVersion =
          this.coordinator.discoveryVersion;
      }
    }
  }
}

function exportCredentialSnapshot(
  state: PersistedMcpOAuthState,
): McpOAuthCredentialSnapshot {
  const clientInformation = state.clientInformation;
  const tokens = state.tokens;
  const validClient =
    clientInformation &&
    "redirect_uris" in clientInformation &&
    clientInformation.redirect_uris.includes(state.redirectUrl)
      ? clientInformation
      : undefined;
  if (!validClient?.client_id || !tokens?.access_token) {
    throw new Error("MCP OAuth authorization is not complete");
  }

  return {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    client_id: validClient.client_id,
    ...(validClient.client_secret
      ? { client_secret: validClient.client_secret }
      : {}),
    redirect_uri: state.redirectUrl,
    ...(tokens.token_type ? { token_type: tokens.token_type } : {}),
    ...(state.tokenExpiresAt !== undefined
      ? {
          expires_in: Math.max(
            0,
            Math.ceil((state.tokenExpiresAt - Date.now()) / 1000),
          ),
        }
      : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
  };
}

function enqueueStorageMutation<T>(
  credentialKey: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const coordinator = getCredentialCoordinator(credentialKey);
  const pending = coordinator.queue.then(mutation, mutation);
  coordinator.queue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function getCredentialCoordinator(
  credentialKey: string,
): CredentialCoordinator {
  const existing = credentialCoordinators.get(credentialKey);
  if (existing) return existing;
  const coordinator: CredentialCoordinator = {
    queue: Promise.resolve(),
    generation: 0,
    clientVersion: 0,
    tokenVersion: 0,
    discoveryVersion: 0,
  };
  credentialCoordinators.set(credentialKey, coordinator);
  return coordinator;
}

function assertCurrentGeneration(
  credentialKey: string,
  expectedGeneration: number,
): void {
  if (
    getCredentialCoordinator(credentialKey).generation !== expectedGeneration
  ) {
    throw new Error(
      "MCP OAuth session is stale because credentials were cleared",
    );
  }
}

async function clearStoredCredentials(
  storage: McpOAuthStorage,
  credentialKey: string,
  expected?: {
    generation: number;
    clientVersion: number;
    tokenVersion: number;
    discoveryVersion: number;
  },
): Promise<{ result: unknown; generation: number; cleared: boolean }> {
  return enqueueStorageMutation(credentialKey, async () => {
    const coordinator = getCredentialCoordinator(credentialKey);
    if (expected) {
      assertCurrentGeneration(credentialKey, expected.generation);
      if (
        coordinator.clientVersion !== expected.clientVersion ||
        coordinator.tokenVersion !== expected.tokenVersion ||
        coordinator.discoveryVersion !== expected.discoveryVersion
      ) {
        return {
          result: false,
          generation: coordinator.generation,
          cleared: false,
        };
      }
    }
    const result = await storage.delete(credentialKey);
    coordinator.generation += 1;
    coordinator.clientVersion += 1;
    coordinator.tokenVersion += 1;
    coordinator.discoveryVersion += 1;
    coordinator.state = undefined;
    return { result, generation: coordinator.generation, cleared: true };
  });
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
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "Content-Type": "text/plain" });
      response.end("Invalid request target");
      return;
    }
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
  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
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

export function mcpOAuthCredentialKey(
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
): Promise<{ state?: PersistedMcpOAuthState; generation: number }> {
  return enqueueStorageMutation(credentialKey, async () => {
    const coordinator = getCredentialCoordinator(credentialKey);
    const state = await readStoredState(storage, credentialKey);
    coordinator.state = state;
    return { state, generation: coordinator.generation };
  });
}

async function readStoredState(
  storage: McpOAuthStorage,
  credentialKey: string,
): Promise<PersistedMcpOAuthState | undefined> {
  const value = await storage.get(credentialKey);
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isPersistedMcpOAuthState(parsed)) {
      await storage.delete(credentialKey);
      return undefined;
    }
    return parsed;
  } catch {
    await storage.delete(credentialKey);
    return undefined;
  }
}

function isPersistedMcpOAuthState(
  value: unknown,
): value is PersistedMcpOAuthState {
  if (
    !isRecord(value) ||
    !SafeUrlSchema.safeParse(value.redirectUrl).success ||
    "codeVerifier" in value
  ) {
    return false;
  }
  if (value.clientInformation !== undefined) {
    if (!isRecord(value.clientInformation)) return false;
    const schema =
      "redirect_uris" in value.clientInformation
        ? OAuthClientInformationFullSchema
        : OAuthClientInformationSchema;
    if (!schema.safeParse(value.clientInformation).success) return false;
  }
  if (
    value.tokens !== undefined &&
    !OAuthTokensSchema.safeParse(value.tokens).success
  ) {
    return false;
  }
  if (
    value.tokenExpiresAt !== undefined &&
    (typeof value.tokenExpiresAt !== "number" ||
      !Number.isFinite(value.tokenExpiresAt))
  ) {
    return false;
  }
  if (value.discoveryState !== undefined) {
    if (
      !isRecord(value.discoveryState) ||
      !SafeUrlSchema.safeParse(value.discoveryState.authorizationServerUrl)
        .success ||
      (value.discoveryState.resourceMetadataUrl !== undefined &&
        !SafeUrlSchema.safeParse(value.discoveryState.resourceMetadataUrl)
          .success) ||
      (value.discoveryState.authorizationServerMetadata !== undefined &&
        !OAuthMetadataSchema.safeParse(
          value.discoveryState.authorizationServerMetadata,
        ).success &&
        !OpenIdProviderDiscoveryMetadataSchema.safeParse(
          value.discoveryState.authorizationServerMetadata,
        ).success) ||
      (value.discoveryState.resourceMetadata !== undefined &&
        !OAuthProtectedResourceMetadataSchema.safeParse(
          value.discoveryState.resourceMetadata,
        ).success)
    ) {
      return false;
    }
  }
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
