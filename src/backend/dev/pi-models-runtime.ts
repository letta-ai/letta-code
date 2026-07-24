import type {
  Api,
  AssistantMessageEventStream,
  AuthResult,
  Context,
  Credential,
  CredentialStore,
  Model,
  ModelsApiStreamOptions,
  ModelsSimpleStreamOptions,
  MutableModels,
  Provider,
} from "@earendil-works/pi-ai";
import { createModels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { createLocalPiCredentialStore } from "@/backend/local/local-pi-credential-store";
import {
  getLocalProviderRecordByName,
  localProviderApiKeyFromRecord,
} from "@/backend/local/local-provider-auth-store";
import {
  createLlamaCppPiProvider,
  LLAMA_CPP_PI_PROVIDER_ID,
} from "./pi-llama-cpp-provider";
import {
  createLmStudioPiProvider,
  LMSTUDIO_PI_PROVIDER_ID,
} from "./pi-lmstudio-provider";
import { createModPiProvider } from "./pi-mod-provider";
import {
  createOllamaPiProvider,
  OLLAMA_CLOUD_PI_PROVIDER_ID,
  OLLAMA_PI_PROVIDER_ID,
} from "./pi-ollama-provider";
import {
  getRegisteredPiProvider,
  getRegisteredPiProviderRevision,
  listRegisteredPiProviders,
} from "./pi-provider-mod-registry";
import { getPiProviderSpec, type PiProvider } from "./pi-provider-registry";
import { resolveRegisteredPiProviderRuntimeConnection } from "./registered-pi-provider-runtime";

const CONFIGURED_DISCOVERY_TIMEOUT_MS = 2_000;
const AUTODETECT_DISCOVERY_TIMEOUT_MS = 500;

export interface LocalPiModelsRuntimeOptions {
  storageDir?: string;
  fetchImpl?: typeof fetch;
}

interface LocalEndpointConnection {
  baseURL: string;
  apiKey?: string;
  configured: boolean;
}

interface ManagedEndpointProviderInput {
  baseURL: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  discoveryTimeoutMs: number;
}

/**
 * Local endpoint providers this runtime discovers and owns end-to-end. Each
 * entry is a real dynamic pi-ai Provider built on the shared
 * `createLocalEndpointPiProvider` skeleton; only the engine's native
 * capability-metadata protocol differs per provider.
 */
const MANAGED_ENDPOINT_PROVIDERS: ReadonlyMap<
  string,
  (input: ManagedEndpointProviderInput) => Provider
> = new Map([
  [OLLAMA_PI_PROVIDER_ID, (input) => createOllamaPiProvider(input)],
  [
    OLLAMA_CLOUD_PI_PROVIDER_ID,
    (input) =>
      createOllamaPiProvider({
        ...input,
        providerId: OLLAMA_CLOUD_PI_PROVIDER_ID,
      }),
  ],
  [LLAMA_CPP_PI_PROVIDER_ID, (input) => createLlamaCppPiProvider(input)],
  [LMSTUDIO_PI_PROVIDER_ID, (input) => createLmStudioPiProvider(input)],
]);

function resolveLocalEndpointConnection(
  providerId: string,
  storageDir?: string,
): LocalEndpointConnection {
  const spec = getPiProviderSpec(providerId as PiProvider);
  let record = null;
  for (const providerName of spec.localProviderNames) {
    record = getLocalProviderRecordByName(providerName, storageDir);
    if (record) break;
  }
  const baseURL =
    record?.base_url ?? spec.baseUrlEnv?.() ?? spec.defaultBaseURL ?? "";
  const apiKey =
    localProviderApiKeyFromRecord(record) ??
    spec.apiKeyEnv?.() ??
    spec.fallbackApiKey;
  return {
    baseURL,
    apiKey,
    configured: record !== null || spec.envConfigured?.() === true,
  };
}

/**
 * Stable credential identity: API keys compare by value; OAuth compares by
 * everything except the volatile access token/expiry (refresh token,
 * account/enterprise fields), so token rotation is not an identity change.
 */
function credentialIdentitySignature(
  credential: Credential | undefined,
): string {
  if (!credential) return "none";
  if (credential.type === "api_key") return `api_key ${credential.key ?? ""}`;
  const { access: _access, expires: _expires, ...identity } = credential;
  return `oauth ${JSON.stringify(identity)}`;
}

function connectionSignature(connection: LocalEndpointConnection): string {
  return [
    connection.baseURL,
    connection.apiKey ?? "",
    String(connection.configured),
  ].join(" ");
}

/**
 * Per-local-backend pi-ai Models runtime: the source of truth for provider
 * registration, model lookup, refresh, and stream dispatch in the local turn
 * path (LET-10126). One instance per LocalBackend — never module-global — so
 * concurrent agents with different storage dirs cannot share mutable provider
 * state.
 *
 * Built-in pi-ai providers are registered as-is. Local endpoint providers
 * that own dynamic discovery (Ollama LET-10127, Ollama Cloud, llama.cpp
 * LET-10128, LM Studio LET-10129) are rebuilt when their Letta-side
 * connection record (base URL/auth) changes; a change invalidates and
 * refreshes only that provider.
 */
export class LocalPiModelsRuntime {
  private readonly models: MutableModels;
  private readonly storageDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly endpointSignatures = new Map<string, string>();
  private readonly modSignatures = new Map<string, string>();
  private readonly modelsStore = new InMemoryModelsStore();
  private readonly credentials: CredentialStore;
  private readonly dynamicBuiltinIds: ReadonlySet<string>;
  private readonly builtinCredentialSignatures = new Map<string, string>();

  constructor(options: LocalPiModelsRuntimeOptions = {}) {
    this.storageDir = options.storageDir;
    this.fetchImpl = options.fetchImpl;
    // Letta's auth.json is the credential source of truth, adapted into the
    // runtime so Models.getAuth() resolves stored keys and refreshes OAuth
    // tokens under the store's write lock.
    this.credentials = createLocalPiCredentialStore(options.storageDir);
    this.models = createModels({
      modelsStore: this.modelsStore,
      credentials: this.credentials,
    });
    const builtins = builtinProviders();
    for (const provider of builtins) {
      this.models.setProvider(provider);
    }
    this.dynamicBuiltinIds = new Set(
      builtins
        .filter((provider) => provider.refreshModels !== undefined)
        .map((provider) => provider.id),
    );
  }

  /**
   * Dynamic built-in catalogs (e.g. Radius) are account-specific: when the
   * stored credential's identity changes, drop the persisted catalog and
   * rebuild the provider so one account's models cannot be listed while
   * turns authenticate as another. Routine access-token refreshes keep the
   * identity (volatile `access`/`expires` fields are excluded), so they do
   * not clear last-known retention.
   */
  private async invalidateDynamicBuiltinsOnCredentialChange(): Promise<void> {
    for (const providerId of this.dynamicBuiltinIds) {
      const credential = await this.credentials.read(providerId);
      const signature = credentialIdentitySignature(credential);
      const previous = this.builtinCredentialSignatures.get(providerId);
      this.builtinCredentialSignatures.set(providerId, signature);
      if (previous === undefined || previous === signature) continue;
      // InMemoryModelsStore deletes synchronously.
      void this.modelsStore.delete(providerId);
      const fresh = builtinProviders().find(
        (provider) => provider.id === providerId,
      );
      if (fresh) this.models.setProvider(fresh);
    }
  }

  /**
   * Resolve request auth for a provider through the runtime: stored
   * credential (via the auth.json adapter, refreshing OAuth as needed) or
   * the provider's ambient sources.
   */
  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    this.ensureManagedProviders(providerId);
    return this.models.getAuth(providerId);
  }

  /** Stored (possibly just-refreshed) credential for a provider. */
  async getStoredCredential(
    providerId: string,
  ): Promise<Credential | undefined> {
    return this.credentials.read(providerId);
  }

  /** Providers whose models this runtime discovers and owns end-to-end. */
  isRuntimeManagedProvider(providerId: string): boolean {
    return (
      getRegisteredPiProvider(providerId) !== undefined ||
      MANAGED_ENDPOINT_PROVIDERS.has(providerId)
    );
  }

  /**
   * Registers/refreshes the pi-ai Provider for a mod registration. Returns
   * true when the provider id is (or was) mod-owned — mod registrations take
   * precedence over the built-in endpoint table, matching pi-model-factory's
   * resolution order. The per-name registry revision detects re-registration
   * so only the affected provider is rebuilt.
   */
  private ensureModProvider(providerId: string): boolean {
    const registered = getRegisteredPiProvider(providerId);
    if (!registered) {
      if (this.modSignatures.delete(providerId)) {
        this.models.deleteProvider(providerId);
        void this.modelsStore.delete(providerId);
      }
      return false;
    }
    const connection = resolveRegisteredPiProviderRuntimeConnection(
      registered,
      this.storageDir,
    );
    const signature = [
      getRegisteredPiProviderRevision(providerId),
      connection.baseURL ?? "",
      connection.apiKey ?? "",
    ].join(" ");
    const previousSignature = this.modSignatures.get(providerId);
    if (
      previousSignature === signature &&
      this.models.getProvider(providerId)
    ) {
      return true;
    }
    if (previousSignature !== undefined && previousSignature !== signature) {
      void this.modelsStore.delete(providerId);
    }
    this.models.setProvider(
      createModPiProvider({
        registered,
        ...(this.storageDir ? { storageDir: this.storageDir } : {}),
      }),
    );
    this.modSignatures.set(providerId, signature);
    return true;
  }

  private ensureEndpointProvider(providerId: string): void {
    const create = MANAGED_ENDPOINT_PROVIDERS.get(providerId);
    if (!create) return;
    const connection = resolveLocalEndpointConnection(
      providerId,
      this.storageDir,
    );
    const signature = connectionSignature(connection);
    const previousSignature = this.endpointSignatures.get(providerId);
    if (
      previousSignature === signature &&
      this.models.getProvider(providerId)
    ) {
      return;
    }
    // Connection changed: replace only this provider and drop its persisted
    // catalog, so stale discovery from the old endpoint cannot be restored
    // by the next refresh. (InMemoryModelsStore deletes synchronously.)
    if (previousSignature !== undefined && previousSignature !== signature) {
      void this.modelsStore.delete(providerId);
    }
    this.models.setProvider(
      create({
        baseURL: connection.baseURL,
        ...(connection.apiKey ? { apiKey: connection.apiKey } : {}),
        ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
        discoveryTimeoutMs: connection.configured
          ? CONFIGURED_DISCOVERY_TIMEOUT_MS
          : AUTODETECT_DISCOVERY_TIMEOUT_MS,
      }),
    );
    this.endpointSignatures.set(providerId, signature);
  }

  private ensureManagedProviders(providerId?: string): void {
    if (providerId !== undefined) {
      if (!this.ensureModProvider(providerId)) {
        this.ensureEndpointProvider(providerId);
      }
      return;
    }
    const modProviderIds = new Set(
      listRegisteredPiProviders().map((provider) => provider.providerName),
    );
    for (const id of modProviderIds) {
      this.ensureModProvider(id);
    }
    for (const id of MANAGED_ENDPOINT_PROVIDERS.keys()) {
      if (!modProviderIds.has(id)) this.ensureEndpointProvider(id);
    }
  }

  getModels(providerId?: string): readonly Model<Api>[] {
    this.ensureManagedProviders(providerId);
    return this.models.getModels(providerId);
  }

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    this.ensureManagedProviders(providerId);
    return this.models.getModel(providerId, modelId);
  }

  /**
   * Canonical catalog refresh: pi-ai's Models.refresh resolves each dynamic
   * provider's effective credential (refreshing OAuth under the store lock),
   * supplies its store-backed RefreshModelsContext, and skips unconfigured
   * providers — so unconfigured remote endpoints and mod listModels hooks
   * are never probed, while keyless local daemons ("not-needed") and
   * credentialed dynamic built-ins (e.g. radius) refresh correctly.
   * Per-provider fetch failures keep that provider's last-known list.
   */
  async refreshAll(): Promise<void> {
    this.ensureManagedProviders();
    await this.invalidateDynamicBuiltinsOnCredentialChange();
    await this.models.refresh({ force: true });
  }

  /**
   * Refresh with per-provider error semantics: rejects with the given
   * provider's fetch error while the provider keeps serving its last-known
   * list.
   */
  async refresh(providerId: string): Promise<void> {
    this.ensureManagedProviders(providerId);
    await this.invalidateDynamicBuiltinsOnCredentialChange();
    // pi-ai refreshes the collection as a whole (configured dynamic
    // providers only); this method adds per-provider error semantics on top.
    const result = await this.models.refresh({ force: true });
    const error = result.errors.get(providerId);
    if (error) throw error;
  }

  /**
   * Runtime model lookup for turn execution: last-known list first, then one
   * refresh attempt for dynamic providers when the model is absent. Returns
   * the same Model instance that listing published.
   */
  async resolveModel(
    providerId: string,
    modelId: string,
  ): Promise<Model<Api> | undefined> {
    const known = this.getModel(providerId, modelId);
    if (known) return known;
    try {
      await this.refresh(providerId);
    } catch {
      // Refresh failure keeps the last-known list; the lookup below decides.
    }
    return this.getModel(providerId, modelId);
  }

  stream<TApi extends Api>(
    model: Model<TApi>,
    context: Context,
    options?: ModelsApiStreamOptions<TApi>,
  ): AssistantMessageEventStream {
    this.ensureManagedProviders((model as Model<Api>).provider);
    return this.models.stream(model, context, options);
  }

  streamSimple(
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ): AssistantMessageEventStream {
    this.ensureManagedProviders(model.provider);
    return this.models.streamSimple(model, context, options);
  }
}
