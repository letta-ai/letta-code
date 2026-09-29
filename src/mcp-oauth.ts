import { createHash, randomBytes } from "node:crypto";
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
import { callbackPort, startOAuthCallbackServer } from "@/mcp-oauth-callback";
import {
  deleteSecretValue,
  getSecretValue,
  setSecretValue,
} from "@/utils/secrets";

const credentialCoordinators = new Map<string, CredentialCoordinator>();
const storageObjectIds = new WeakMap<object, number>();
let nextStorageObjectId = 1;

interface CredentialCoordinator {
  queue: Promise<void>;
  generation: number;
  state?: PersistedMcpOAuthState;
  activeProviders: number;
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
  closeCallback?(): Promise<void>;
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
  /** Stable identity for wrappers around the same physical storage backend. */
  storageNamespace?: string;
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
  const coordinationKey = storageCoordinationKey(
    bunSecretStorage,
    credentialKey,
    "bun-secrets",
  );
  const { result } = await clearStoredCredentials(
    bunSecretStorage,
    credentialKey,
    coordinationKey,
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
    storageNamespace: "bun-secrets",
    storage: bunSecretStorage,
    interactive: options.interactive,
    onStatus: options.onStatus,
    openBrowser: options.openBrowser ?? openSystemBrowser,
  });
}

export async function createMcpOAuthSessionWithStorage(
  options: StorageInjectedMcpOAuthSessionOptions,
): Promise<ExportableMcpOAuthSession | undefined> {
  const coordinationKey = storageCoordinationKey(
    options.storage,
    options.credentialKey,
    options.storageNamespace,
  );
  retainCredentialCoordinator(coordinationKey);
  let provider: PersistentMcpOAuthProvider | undefined;
  let callback:
    | Awaited<ReturnType<typeof startOAuthCallbackServer>>
    | undefined;
  try {
    const loaded = await loadState(
      options.storage,
      options.credentialKey,
      coordinationKey,
    );
    const persisted = loaded.state;
    if (!options.interactive && !persisted) {
      await releaseCredentialCoordinator(coordinationKey);
      return undefined;
    }

    callback = options.interactive
      ? await startOAuthCallbackServer(callbackPort(persisted?.redirectUrl))
      : undefined;
    const redirectUrl = callback?.redirectUrl ?? persisted?.redirectUrl;
    if (!redirectUrl) {
      await releaseCredentialCoordinator(coordinationKey);
      return undefined;
    }

    provider = new PersistentMcpOAuthProvider({
      credentialKey: options.credentialKey,
      coordinationKey,
      storage: options.storage,
      redirectUrl,
      persisted,
      interactive: options.interactive,
      onStatus: options.onStatus,
      openBrowser: options.openBrowser ?? openSystemBrowser,
      expectedState: callback?.expectedState,
      generation: loaded.generation,
    });
    const activeProvider = provider;
    const activeCallback = callback;
    return {
      authProvider: activeProvider,
      ...(activeCallback
        ? { waitForAuthorizationCode: () => activeCallback.waitForCode() }
        : {}),
      exportCredentials: () => activeProvider.exportCredentials(),
      closeCallback: async () => activeCallback?.close(),
      close: async () => {
        activeCallback?.close();
        await activeProvider.dispose();
      },
    };
  } catch (error) {
    callback?.close();
    if (provider) await provider.dispose();
    else await releaseCredentialCoordinator(coordinationKey);
    throw error;
  }
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
  private coordinatorValue?: CredentialCoordinator;
  private readonly credentialKey: string;
  private readonly coordinationKey: string;
  private readonly storage: McpOAuthStorage;
  private readonly interactive: boolean;
  private readonly onStatus?: (message: string) => void;
  private readonly openBrowser: (url: string) => Promise<void>;
  private readonly expectedState?: { value?: string };
  private closed = false;

  constructor(options: {
    credentialKey: string;
    coordinationKey: string;
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
    this.coordinationKey = options.coordinationKey;
    this.storage = options.storage;
    this.interactive = options.interactive;
    this.onStatus = options.onStatus;
    this.openBrowser = options.openBrowser;
    this.expectedState = options.expectedState;
    this.generation = options.generation;
    const coordinator = getCredentialCoordinator(options.coordinationKey);
    this.coordinatorValue = coordinator;
    this.observedClientVersion = coordinator.clientVersion;
    this.observedTokenVersion = coordinator.tokenVersion;
    this.observedDiscoveryVersion = coordinator.discoveryVersion;
    this.tokenOperationGeneration = coordinator.generation;
    this.tokenOperationVersion = coordinator.tokenVersion;
    this.stateData = {
      ...options.persisted,
      redirectUrl: options.redirectUrl,
    };
  }

  get redirectUrl(): string {
    this.assertOpen();
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
    this.assertOpen();
    const state = randomBytes(24).toString("base64url");
    if (this.expectedState) this.expectedState.value = state;
    return state;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    this.assertOpen();
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
    this.assertOpen();
    assertCurrentGeneration(this.coordinationKey, this.generation);
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
    this.assertOpen();
    if (this.generation !== this.coordinator.generation) return undefined;
    this.observedTokenVersion = this.coordinator.tokenVersion;
    this.tokenOperationGeneration = this.coordinator.generation;
    this.tokenOperationVersion = this.coordinator.tokenVersion;
    return this.coordinator.state?.tokens;
  }

  async exportCredentials(): Promise<McpOAuthCredentialSnapshot> {
    this.assertOpen();
    const expectedGeneration = this.generation;
    return enqueueStorageMutation(this.coordinationKey, async () => {
      this.assertOpen();
      assertCurrentGeneration(this.coordinationKey, expectedGeneration);
      const latest = await readStoredState(this.storage, this.credentialKey);
      if (!latest) {
        throw new Error("MCP OAuth authorization is not complete");
      }
      this.assertOpen();
      this.coordinator.state = latest;
      this.stateData = latest;
      return exportCredentialSnapshot(latest);
    });
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.assertOpen();
    const expectedGeneration = this.tokenOperationGeneration;
    const expectedTokenVersion = this.tokenOperationVersion;
    const tokenExpiresAt =
      tokens.expires_in === undefined
        ? undefined
        : Date.now() + tokens.expires_in * 1000;
    const pendingClientInformation = this.pendingClientInformation;
    const pendingDiscoveryState = this.pendingDiscoveryState;
    const result = await enqueueStorageMutation(
      this.coordinationKey,
      async () => {
        this.assertOpen();
        assertCurrentGeneration(this.coordinationKey, expectedGeneration);
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
    this.codeVerifierValue = undefined;
    if (this.closed) {
      this.scrubLocalState();
      return;
    }
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
    this.assertOpen();
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
    this.assertOpen();
    this.codeVerifierValue = codeVerifier;
  }

  codeVerifier(): string {
    this.assertOpen();
    if (!this.codeVerifierValue) {
      throw new Error("No MCP OAuth PKCE verifier is available");
    }
    return this.codeVerifierValue;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.assertOpen();
    assertCurrentGeneration(this.coordinationKey, this.generation);
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
    this.assertOpen();
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
    this.assertOpen();
    if (scope === "verifier") {
      this.codeVerifierValue = undefined;
      return;
    }
    if (scope === "all") {
      const redirectUrl = this.redirectUrl;
      const { generation, cleared } = await clearStoredCredentials(
        this.storage,
        this.credentialKey,
        this.coordinationKey,
        {
          generation: this.generation,
          clientVersion: this.observedClientVersion,
          tokenVersion: this.observedTokenVersion,
          discoveryVersion: this.observedDiscoveryVersion,
        },
      );
      if (this.closed) return;
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
      this.coordinationKey,
      async () => {
        this.assertOpen();
        assertCurrentGeneration(this.coordinationKey, expectedGeneration);
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
    if (this.closed) return;
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

  async dispose(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.scrubLocalState();
    try {
      await releaseCredentialCoordinator(this.coordinationKey);
    } finally {
      this.coordinatorValue = undefined;
      this.scrubLocalState();
    }
  }

  private get coordinator(): CredentialCoordinator {
    if (!this.coordinatorValue) throw new Error("MCP OAuth session is closed");
    return this.coordinatorValue;
  }

  private scrubLocalState(): void {
    this.codeVerifierValue = undefined;
    this.pendingClientInformation = undefined;
    this.pendingDiscoveryState = undefined;
    this.stateData = { redirectUrl: this.stateData.redirectUrl };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("MCP OAuth session is closed");
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
  coordinationKey: string,
  mutation: () => Promise<T>,
): Promise<T> {
  const coordinator = getCredentialCoordinator(coordinationKey);
  const pending = coordinator.queue.then(mutation, mutation);
  coordinator.queue = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function getCredentialCoordinator(
  coordinationKey: string,
): CredentialCoordinator {
  const existing = credentialCoordinators.get(coordinationKey);
  if (existing) return existing;
  const coordinator: CredentialCoordinator = {
    queue: Promise.resolve(),
    generation: 0,
    activeProviders: 0,
    clientVersion: 0,
    tokenVersion: 0,
    discoveryVersion: 0,
  };
  credentialCoordinators.set(coordinationKey, coordinator);
  return coordinator;
}

function storageCoordinationKey(
  storage: McpOAuthStorage,
  credentialKey: string,
  storageNamespace?: string,
): string {
  const namespace = storageNamespace;
  if (
    namespace !== undefined &&
    (!namespace.trim() || namespace.includes("\0"))
  ) {
    throw new Error(
      "MCP OAuth storage namespace must be non-empty and contain no NUL bytes",
    );
  }
  let identity: string;
  if (!namespace) {
    let objectId = storageObjectIds.get(storage);
    if (!objectId) {
      objectId = nextStorageObjectId;
      nextStorageObjectId += 1;
      storageObjectIds.set(storage, objectId);
    }
    identity = `object:${objectId}`;
  } else {
    identity = `namespace:${namespace}`;
  }
  return `${identity}\0${credentialKey}`;
}

function retainCredentialCoordinator(coordinationKey: string): void {
  getCredentialCoordinator(coordinationKey).activeProviders += 1;
}

async function releaseCredentialCoordinator(
  coordinationKey: string,
): Promise<void> {
  const coordinator = getCredentialCoordinator(coordinationKey);
  await enqueueStorageMutation(coordinationKey, async () => {
    coordinator.activeProviders = Math.max(0, coordinator.activeProviders - 1);
    if (coordinator.activeProviders === 0) coordinator.state = undefined;
  });
  await coordinator.queue;
  if (
    coordinator.activeProviders === 0 &&
    credentialCoordinators.get(coordinationKey) === coordinator
  ) {
    credentialCoordinators.delete(coordinationKey);
  }
}

function assertCurrentGeneration(
  coordinationKey: string,
  expectedGeneration: number,
): void {
  if (
    getCredentialCoordinator(coordinationKey).generation !== expectedGeneration
  ) {
    throw new Error(
      "MCP OAuth session is stale because credentials were cleared",
    );
  }
}

async function clearStoredCredentials(
  storage: McpOAuthStorage,
  credentialKey: string,
  coordinationKey: string,
  expected?: {
    generation: number;
    clientVersion: number;
    tokenVersion: number;
    discoveryVersion: number;
  },
): Promise<{ result: unknown; generation: number; cleared: boolean }> {
  const coordinator = getCredentialCoordinator(coordinationKey);
  const outcome = await enqueueStorageMutation(coordinationKey, async () => {
    if (expected) {
      assertCurrentGeneration(coordinationKey, expected.generation);
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
  await coordinator.queue;
  if (
    coordinator.activeProviders === 0 &&
    credentialCoordinators.get(coordinationKey) === coordinator
  ) {
    credentialCoordinators.delete(coordinationKey);
  }
  return outcome;
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
  coordinationKey: string,
): Promise<{ state?: PersistedMcpOAuthState; generation: number }> {
  return enqueueStorageMutation(coordinationKey, async () => {
    const coordinator = getCredentialCoordinator(coordinationKey);
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
