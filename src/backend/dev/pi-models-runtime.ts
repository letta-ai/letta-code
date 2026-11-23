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
import {
  createModels,
  defaultProviderAuthContext,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
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
  normalizeOllamaModelId,
  OLLAMA_CLOUD_PI_PROVIDER_ID,
  OLLAMA_PI_PROVIDER_ID,
  resolveOllamaServedContext,
} from "./pi-ollama-provider";
import { createOpenAICompatiblePiProvider } from "./pi-openai-compatible-provider";
import {
  getRegisteredPiProvider,
  getRegisteredPiProviderRevision,
  listRegisteredPiProviders,
} from "./pi-provider-mod-registry";
import {
  getPiProviderSpec,
  OPENAI_COMPATIBLE_PI_PROVIDER_ID,
  type PiProvider,
} from "./pi-provider-registry";
import { resolveRegisteredPiProviderRuntimeConnection } from "./registered-pi-provider-runtime";

const CONFIGURED_DISCOVERY_TIMEOUT_MS = 2_000;
const AUTODETECT_DISCOVERY_TIMEOUT_MS = 500;
const MAX_TURN_RESOLUTION_RETRIES = 2;

const PROVIDER_ENV_ALIASES: Readonly<Record<string, readonly string[]>> = {
  GEMINI_API_KEY: ["GOOGLE_GENERATIVE_AI_API_KEY"],
};

function aliasedAuthContext() {
  const base = defaultProviderAuthContext();
  return {
    env: async (name: string) => {
      const direct = await base.env(name);
      if (direct) return direct;
      for (const alias of PROVIDER_ENV_ALIASES[name] ?? []) {
        const value = await base.env(alias);
        if (value) return value;
      }
      return undefined;
    },
    fileExists: (path: string) => base.fileExists(path),
  };
}

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
  [
    OPENAI_COMPATIBLE_PI_PROVIDER_ID,
    (input) => createOpenAICompatiblePiProvider(input),
  ],
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
    (record !== null || spec.autoDetectLocalEndpoint === true
      ? spec.fallbackApiKey
      : undefined);
  return {
    baseURL,
    apiKey,
    configured: record !== null || spec.envConfigured?.() === true,
  };
}

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

function withOllamaServedContext(
  model: Model<Api>,
  servedContext: number,
): Model<Api> {
  const contextWindow = servedContext;
  const maxTokens = Math.min(model.maxTokens, contextWindow);
  if (model.contextWindow === contextWindow && model.maxTokens === maxTokens) {
    return model;
  }
  return { ...model, contextWindow, maxTokens };
}

export class LocalPiModelsRuntime {
  private readonly models: MutableModels;
  private readonly storageDir?: string;
  private readonly fetchImpl?: typeof fetch;
  private readonly endpointSignatures = new Map<string, string>();
  private readonly modSignatures = new Map<string, string>();
  private readonly modelsStore = new InMemoryModelsStore();
  private readonly credentials: CredentialStore;
  private readonly dynamicBuiltinIds: ReadonlySet<string>;
  private readonly credentialSignatures = new Map<string, string>();

  constructor(options: LocalPiModelsRuntimeOptions = {}) {
    this.storageDir = options.storageDir;
    this.fetchImpl = options.fetchImpl;
    this.credentials = createLocalPiCredentialStore(options.storageDir);
    this.models = createModels({
      modelsStore: this.modelsStore,
      credentials: this.credentials,
      authContext: aliasedAuthContext(),
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

  private accountScopedProviderIds(): Set<string> {
    const ids = new Set(this.dynamicBuiltinIds);
    for (const registered of listRegisteredPiProviders()) {
      if (registered.config.listModels) ids.add(registered.providerName);
      else ids.delete(registered.providerName);
    }
    return ids;
  }

  private async invalidateOnCredentialChange(): Promise<void> {
    for (const providerId of this.accountScopedProviderIds()) {
      const credential = await this.credentials.read(providerId);
      const signature = credentialIdentitySignature(credential);
      const previous = this.credentialSignatures.get(providerId);
      this.credentialSignatures.set(providerId, signature);
      if (previous === undefined || previous === signature) continue;
      void this.modelsStore.delete(providerId);
      const registered = getRegisteredPiProvider(providerId);
      if (registered) {
        this.models.setProvider(
          createModPiProvider({
            registered,
            ...(this.storageDir ? { storageDir: this.storageDir } : {}),
          }),
        );
        continue;
      }
      const fresh = builtinProviders().find(
        (provider) => provider.id === providerId,
      );
      if (fresh) this.models.setProvider(fresh);
    }
  }

  async getAuth(providerId: string): Promise<AuthResult | undefined> {
    this.ensureManagedProviders(providerId);
    await this.invalidateOnCredentialChange();
    return this.models.getAuth(providerId);
  }

  async resolveTurn(
    providerId: string,
    modelId: string,
    fallbackModelId?: string,
    abortSignal?: AbortSignal,
  ): Promise<{ model: Model<Api> | undefined; auth: AuthResult | undefined }> {
    this.ensureManagedProviders(providerId);
    const lookup = () =>
      this.models.getModel(providerId, modelId) ??
      (this.isBuiltInLocalOllamaProvider(providerId)
        ? this.models.getModel(providerId, normalizeOllamaModelId(modelId))
        : undefined) ??
      (fallbackModelId
        ? this.models.getModel(providerId, fallbackModelId)
        : undefined);
    for (let attempt = 0; ; attempt++) {
      this.ensureManagedProviders(providerId);
      await this.invalidateOnCredentialChange();
      const auth = await this.models.getAuth(providerId);
      const isLocalOllama = this.isBuiltInLocalOllamaProvider(providerId);
      const ollamaConnection = isLocalOllama
        ? resolveLocalEndpointConnection(providerId, this.storageDir)
        : undefined;
      const expectedEndpointSignature = isLocalOllama
        ? this.endpointSignatures.get(providerId)
        : undefined;
      if (
        ollamaConnection &&
        connectionSignature(ollamaConnection) !== expectedEndpointSignature
      ) {
        if (attempt >= MAX_TURN_RESOLUTION_RETRIES) {
          throw new Error(
            `Connection for provider "${providerId}" changed repeatedly during turn resolution; retry the request.`,
          );
        }
        continue;
      }

      let ollamaServedContext: number | undefined;
      if (ollamaConnection) {
        ollamaServedContext = await resolveOllamaServedContext({
          baseURL: ollamaConnection.baseURL,
          modelId,
          ...(ollamaConnection.apiKey
            ? { apiKey: ollamaConnection.apiKey }
            : {}),
          ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
          ...(abortSignal ? { signal: abortSignal } : {}),
        });
        try {
          await this.refresh(providerId);
        } catch {}
      }

      let model = lookup();
      if (!model) {
        try {
          await this.models.refresh({ force: true });
        } catch {}
        model = lookup();
      }
      const credentialMoved =
        await this.credentialIdentityMovedSinceInvalidation(providerId);
      const endpointMoved =
        ollamaConnection !== undefined &&
        (this.endpointSignatures.get(providerId) !==
          expectedEndpointSignature ||
          connectionSignature(
            resolveLocalEndpointConnection(providerId, this.storageDir),
          ) !== expectedEndpointSignature);
      if (credentialMoved || endpointMoved) {
        if (attempt >= MAX_TURN_RESOLUTION_RETRIES) {
          throw new Error(
            `${endpointMoved ? "Connection" : "Credentials"} for provider "${providerId}" changed repeatedly ` +
              "during turn resolution; retry the request.",
          );
        }
        continue;
      }
      return {
        model:
          model && ollamaServedContext !== undefined
            ? withOllamaServedContext(model, ollamaServedContext)
            : model,
        auth,
      };
    }
  }

  private async credentialIdentityMovedSinceInvalidation(
    providerId: string,
  ): Promise<boolean> {
    const recorded = this.credentialSignatures.get(providerId);
    if (recorded === undefined) return false;
    const credential = await this.credentials.read(providerId);
    return credentialIdentitySignature(credential) !== recorded;
  }

  async getStoredCredential(
    providerId: string,
  ): Promise<Credential | undefined> {
    return this.credentials.read(providerId);
  }

  isRuntimeManagedProvider(providerId: string): boolean {
    return (
      getRegisteredPiProvider(providerId) !== undefined ||
      MANAGED_ENDPOINT_PROVIDERS.has(providerId)
    );
  }

  isBuiltInLocalOllamaProvider(providerId: string): boolean {
    return (
      providerId === OLLAMA_PI_PROVIDER_ID &&
      getRegisteredPiProvider(providerId) === undefined
    );
  }

  private ensureModProvider(providerId: string): boolean {
    const registered = getRegisteredPiProvider(providerId);
    if (!registered) {
      if (this.modSignatures.delete(providerId)) {
        this.models.deleteProvider(providerId);
        void this.modelsStore.delete(providerId);
        const builtin = builtinProviders().find(
          (provider) => provider.id === providerId,
        );
        if (builtin) this.models.setProvider(builtin);
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

  async refreshAll(): Promise<void> {
    this.ensureManagedProviders();
    await this.invalidateOnCredentialChange();
    await this.models.refresh({ force: true });
  }

  async refresh(providerId: string): Promise<void> {
    this.ensureManagedProviders(providerId);
    await this.invalidateOnCredentialChange();
    const result = await this.models.refresh({ force: true });
    const error = result.errors.get(providerId);
    if (error) throw error;
  }

  async resolveModel(
    providerId: string,
    modelId: string,
  ): Promise<Model<Api> | undefined> {
    await this.invalidateOnCredentialChange();
    const known = this.getModel(providerId, modelId);
    if (known) return known;
    try {
      await this.refresh(providerId);
    } catch {}
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
