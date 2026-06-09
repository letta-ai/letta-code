import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getOAuthProvider,
  type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import {
  type AuthCredential,
  AuthStorage,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import {
  type LocalProviderRecord,
  listLocalProviderRecords,
} from "@/backend/local/local-provider-auth-store";
import {
  getPiProviderSpec,
  isPiProvider,
  type PiProvider,
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "./pi-provider-registry";

// Adapter boundary: LC owns local storage paths, auth UI records, endpoint
// discovery, and API-shaped projection. Built-in provider catalog/auth model
// metadata should come from Pi's ModelRegistry so local backend behavior stays
// aligned with Pi instead of duplicating pi-ai catalog policy here.

export interface PiRegistryCatalogModel {
  handle: string;
  model: Model<Api>;
  modelEndpointType: string;
}

function piProviderIdForProvider(provider: PiProvider): string | undefined {
  const spec = getPiProviderSpec(provider);
  return spec.piProvider ?? spec.id;
}

function piProviderIdForRecord(
  record: LocalProviderRecord,
): string | undefined {
  const provider =
    resolveProviderFromProviderType(record.provider_type) ??
    resolveProviderFromModelHandle(record.name);
  if (!provider) return record.provider_type || record.name;
  return piProviderIdForProvider(provider);
}

function credentialForRecord(
  record: LocalProviderRecord,
): AuthCredential | undefined {
  if (record.auth.type === "api") {
    if (record.auth.key === "not-needed") return undefined;
    return { type: "api_key", key: record.auth.key };
  }

  return {
    type: "oauth",
    access: record.auth.access,
    refresh: record.auth.refresh ?? "",
    ...(record.auth.idToken ? { idToken: record.auth.idToken } : {}),
    expires: record.auth.expires,
    ...(record.auth.accountId ? { accountId: record.auth.accountId } : {}),
  } satisfies AuthCredential;
}

function localAuthStorage(storageDir?: string): AuthStorage {
  const credentials: Record<string, AuthCredential> = {};
  for (const record of listLocalProviderRecords(storageDir)) {
    const providerId = piProviderIdForRecord(record);
    const credential = credentialForRecord(record);
    if (!providerId || !credential) continue;
    credentials[providerId] = credential;
  }
  return AuthStorage.inMemory(credentials);
}

export function createLocalPiModelRegistry(storageDir?: string): ModelRegistry {
  return ModelRegistry.inMemory(localAuthStorage(storageDir));
}

function modelHandleForProviderModel(
  provider: PiProvider,
  model: Model<Api>,
): string | undefined {
  const spec = getPiProviderSpec(provider);
  return spec.catalogModelHandle?.(model) ?? `${provider}/${model.id}`;
}

export function listPiRegistryCatalogModelsForProvider(
  provider: PiProvider,
  storageDir?: string,
): PiRegistryCatalogModel[] {
  const spec = getPiProviderSpec(provider);
  if (!spec.piProvider) return [];
  const registry = createLocalPiModelRegistry(storageDir);
  return registry
    .getAll()
    .filter((model) => model.provider === spec.piProvider)
    .map((model) => ({
      handle: modelHandleForProviderModel(provider, model) ?? model.id,
      model,
      modelEndpointType: spec.providerTypes[0] ?? provider,
    }));
}

export function findPiRegistryModelForHandle(
  handle: string | undefined,
  storageDir?: string,
): Model<Api> | undefined {
  if (!handle) return undefined;

  const provider = resolveProviderFromModelHandle(handle);
  if (!provider || !isPiProvider(provider)) return undefined;
  const spec = getPiProviderSpec(provider);
  const piProvider = spec.piProvider;
  if (!piProvider) return undefined;
  const modelId = stripProviderHandlePrefix(handle, provider);
  if (!modelId) return undefined;

  const registry = createLocalPiModelRegistry(storageDir);
  const exact = registry.find(piProvider, modelId);
  if (exact) return exact;

  if (piProvider === "openai") {
    const withoutReleaseDate = modelId.replace(/-\d{4}-\d{2}-\d{2}$/, "");
    if (withoutReleaseDate !== modelId) {
      return registry.find(piProvider, withoutReleaseDate);
    }
  }
  return undefined;
}

export function findPiRegistryModelForProviderModel(input: {
  provider: PiProvider;
  modelId: string;
  storageDir?: string;
  oauthCredentials?: OAuthCredentials;
}): Model<Api> | undefined {
  const spec = getPiProviderSpec(input.provider);
  const piProvider = spec.piProvider;
  if (!piProvider) return undefined;

  const model = findPiRegistryModelForHandle(
    `${input.provider}/${input.modelId}`,
    input.storageDir,
  );
  if (!model || !input.oauthCredentials) return model;

  // ModelRegistry applies OAuth model modifications for credentials stored in
  // AuthStorage. Runtime resolution may already have refreshed credentials in
  // LC's provider store, so keep this explicit bridge for that path.
  const oauthProvider = getOAuthProvider(piProvider);
  return (
    oauthProvider?.modifyModels?.([model], input.oauthCredentials)[0] ?? model
  );
}
