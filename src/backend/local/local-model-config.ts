import type { Api, Model } from "@earendil-works/pi-ai";
import {
  DEFAULT_PI_PROVIDER,
  isUnselectedLocalModelHandle,
  type PiProvider,
  UNSELECTED_LOCAL_MODEL_HANDLE,
} from "@/backend/dev/pi-model-factory";
import { LocalPiModelsRuntime } from "@/backend/dev/pi-models-runtime";
import {
  getRegisteredPiProvider,
  listRegisteredPiProviders,
  resolveRegisteredPiProviderFromModelHandle,
  stripRegisteredProviderHandlePrefix,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  getPiProviderSpec,
  isPiProvider,
  listConfiguredPiProviders,
  localModelHandle,
  localProviderType,
  PI_PROVIDER_SPECS,
  resolveLocalModel,
  resolveProviderFromModelHandle,
  resolveProviderFromProviderType,
  stripProviderHandlePrefix,
} from "@/backend/dev/pi-provider-registry";
import { isRegisteredPiProviderConfigured } from "@/backend/dev/registered-pi-provider-runtime";
import {
  type LocalProviderRecord,
  listLocalProviderRecords,
} from "./local-provider-auth-store";

export interface LocalModelConfig {
  provider: PiProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

export { UNSELECTED_LOCAL_MODEL_HANDLE };

interface LocalModelListEntry {
  display_name: string;
  handle: string;
  max_context_window?: number;
  max_tokens?: number;
  model: string;
  model_endpoint_type: string;
  name: string;
  provider_type: string;
}

interface ListLocalModelsOptions {
  fetch?: typeof fetch;
  /**
   * Per-backend pi-ai Models runtime that owns all dynamic model discovery.
   * When omitted, a call-scoped runtime is created (honoring `fetch`), so
   * /model and turn execution always read provider-published Model objects.
   */
  modelsRuntime?: LocalPiModelsRuntime;
}

function localProviderNamesFromRecords(
  records: readonly LocalProviderRecord[],
): Set<string> {
  return new Set(records.map((record) => record.name));
}

function isDiscoverableLocalProvider(provider: PiProvider): boolean {
  return getPiProviderSpec(provider).localModelDiscovery !== undefined;
}

function isAutoDetectableLocalEndpointProvider(provider: PiProvider): boolean {
  return getPiProviderSpec(provider).autoDetectLocalEndpoint === true;
}

function isPiProviderForLocalModelHandle(
  provider: PiProvider | string,
): provider is PiProvider {
  return isPiProvider(provider);
}

export function resolveLocalProvider(storageDir?: string): PiProvider {
  const records = listLocalProviderRecords(storageDir);
  const registeredProvider = listRegisteredPiProviders().find(
    (provider) =>
      isRegisteredPiProviderConfigured(provider, records) &&
      (provider.config.models?.length ?? 0) > 0,
  );
  if (registeredProvider) return registeredProvider.providerName as PiProvider;
  return (
    listConfiguredPiProviders(localProviderNamesFromRecords(records))[0] ??
    DEFAULT_PI_PROVIDER
  );
}

export { localModelHandle, localProviderType, resolveLocalModel };

function localProviderTypeForModelConfig(
  provider: PiProvider | string,
): string {
  return isPiProviderForLocalModelHandle(provider)
    ? localProviderType(provider)
    : provider;
}

export function localModelSettingsForHandle(
  handle: string | undefined,
  modelsRuntime?: LocalPiModelsRuntime,
): Record<string, unknown> | undefined {
  if (!handle) return undefined;
  const registeredName = resolveRegisteredPiProviderFromModelHandle(handle);
  const provider = registeredName ?? resolveProviderFromModelHandle(handle);
  if (!provider) return undefined;
  const modelId = registeredName
    ? stripRegisteredProviderHandlePrefix(handle, registeredName)
    : stripProviderHandlePrefix(handle, provider as PiProvider);
  if (!modelId) return undefined;

  // Settings derive from the same runtime-published Model that listing and
  // turn execution resolve — no registration or static-catalog re-reads.
  const runtime =
    modelsRuntime ?? new LocalPiModelsRuntime({ storageDir: undefined });
  const runtimeProviderId = registeredName
    ? registeredName
    : isPiProvider(provider)
      ? runtime.isRuntimeManagedProvider(provider)
        ? provider
        : getPiProviderSpec(provider).piProvider
      : provider;
  const model = runtimeProviderId
    ? runtime.getModels(runtimeProviderId).find((entry) => entry.id === modelId)
    : undefined;
  if (!model) return undefined;
  return {
    provider_type: localProviderTypeForModelConfig(provider),
    context_window_limit: model.contextWindow,
    max_tokens: model.maxTokens,
  };
}

export function resolveLocalModelConfig(
  storageDir?: string,
  modelsRuntime?: LocalPiModelsRuntime,
): LocalModelConfig {
  const runtime =
    modelsRuntime ??
    new LocalPiModelsRuntime({ ...(storageDir ? { storageDir } : {}) });
  const provider = resolveLocalProvider(storageDir);
  const registeredName = getRegisteredPiProvider(provider)?.providerName;
  const registeredModel = registeredName
    ? runtime.getModels(registeredName)[0]
    : undefined;
  const defaultModel = registeredName ? undefined : resolveLocalModel(provider);
  const model =
    registeredModel?.id ??
    (registeredName ? "default" : defaultModel) ??
    UNSELECTED_LOCAL_MODEL_HANDLE;
  const handle = registeredName
    ? `${provider}/${model}`
    : model === UNSELECTED_LOCAL_MODEL_HANDLE
      ? UNSELECTED_LOCAL_MODEL_HANDLE
      : localModelHandle(provider, model);
  const modelSettings = localModelSettingsForHandle(handle, runtime);
  return {
    provider,
    model,
    handle,
    modelSettings: {
      provider_type: localProviderTypeForModelConfig(provider),
      ...(modelSettings ?? {}),
    },
  };
}

/**
 * Catalog handles for a static built-in provider, read from the runtime's
 * registered provider (the same Model objects turn execution resolves).
 */
function catalogHandlesForProvider(
  provider: PiProvider,
  modelsRuntime: LocalPiModelsRuntime,
): string[] {
  const spec = getPiProviderSpec(provider);
  const seen = new Set<string>();
  const handles: string[] = [];
  const add = (handle: string | undefined) => {
    if (!handle || seen.has(handle)) return;
    seen.add(handle);
    handles.push(handle);
  };
  add(spec.defaultModel);
  if (spec.piProvider && spec.catalogModelHandle) {
    for (const model of modelsRuntime.getModels(spec.piProvider)) {
      add(spec.catalogModelHandle(model));
    }
  }
  return handles;
}

function providerForLocalModelListEntry(
  entry: LocalModelListEntry,
): PiProvider | undefined {
  return (
    resolveProviderFromModelHandle(entry.handle) ??
    resolveProviderFromProviderType(entry.model_endpoint_type)
  );
}

export async function resolveAvailableLocalModelForTurn(input: {
  model?: string | null;
  modelSettings?: Record<string, unknown> | null;
  storageDir?: string;
  modelsRuntime?: LocalPiModelsRuntime;
}): Promise<{ model?: string; modelSettings: Record<string, unknown> }> {
  const baseSettings = { ...(input.modelSettings ?? {}) };
  if (
    typeof input.model === "string" &&
    !isUnselectedLocalModelHandle(input.model)
  ) {
    return { model: input.model, modelSettings: baseSettings };
  }

  const preferredProvider = resolveProviderFromProviderType(
    baseSettings.provider_type,
  );
  const models = await listLocalModels(input.storageDir, {
    ...(input.modelsRuntime ? { modelsRuntime: input.modelsRuntime } : {}),
  });
  const selected = preferredProvider
    ? models.find(
        (entry) => providerForLocalModelListEntry(entry) === preferredProvider,
      )
    : models[0];

  if (!selected) {
    return { model: undefined, modelSettings: baseSettings };
  }

  return {
    model: selected.handle,
    modelSettings: {
      ...baseSettings,
      ...localModelSettingsForHandle(selected.handle, input.modelsRuntime),
      provider_type: selected.model_endpoint_type,
    },
  };
}

export async function listLocalModels(
  storageDir?: string,
  options: ListLocalModelsOptions = {},
) {
  // The Models runtime owns all dynamic discovery. The backend threads its
  // instance; direct callers (tests, library use) get a call-scoped one that
  // honors an injected fetch.
  const modelsRuntime =
    options.modelsRuntime ??
    new LocalPiModelsRuntime({
      ...(storageDir ? { storageDir } : {}),
      ...(options.fetch ? { fetchImpl: options.fetch } : {}),
    });
  const records = listLocalProviderRecords(storageDir);
  const providerNames = localProviderNamesFromRecords(records);
  // One collection-wide refresh (pi-ai 0.81 semantics): configured dynamic
  // providers re-fetch, per-provider failures keep last-known lists.
  await modelsRuntime.refreshAll();
  const configured = resolveLocalModelConfig(storageDir);
  const models: LocalModelListEntry[] = [];
  const registeredProviders = listRegisteredPiProviders();
  const addModel = (
    provider: PiProvider | string,
    model: string,
    options: {
      handle?: string;
      maxContextWindow?: number;
      maxOutputTokens?: number;
      modelEndpointType?: string;
      name?: string;
    } = {},
  ) => {
    const handle =
      options.handle ??
      (typeof provider === "string" &&
      !isPiProviderForLocalModelHandle(provider)
        ? `${provider}/${model}`
        : localModelHandle(provider as PiProvider, model));
    if (models.some((entry) => entry.handle === handle)) return;
    const modelSettings = localModelSettingsForHandle(handle, modelsRuntime);
    const maxContextWindow =
      options.maxContextWindow ??
      (typeof modelSettings?.context_window_limit === "number"
        ? modelSettings.context_window_limit
        : undefined);
    const maxOutputTokens =
      options.maxOutputTokens ??
      (typeof modelSettings?.max_tokens === "number"
        ? modelSettings.max_tokens
        : undefined);
    const modelId =
      typeof provider === "string" && isPiProvider(provider)
        ? (stripProviderHandlePrefix(handle, provider) ?? model)
        : model;
    const providerSpec = isPiProvider(provider)
      ? getPiProviderSpec(provider)
      : undefined;
    const catalogModel = providerSpec?.piProvider
      ? modelsRuntime
          .getModels(providerSpec.piProvider)
          .find((entry) => entry.id === modelId)
      : undefined;
    const providerType =
      options.modelEndpointType ?? localProviderTypeForModelConfig(provider);
    const name = options.name ?? catalogModel?.name ?? modelId;
    models.push({
      display_name: name,
      handle,
      ...(maxContextWindow ? { max_context_window: maxContextWindow } : {}),
      ...(maxOutputTokens ? { max_tokens: maxOutputTokens } : {}),
      model: handle,
      model_endpoint_type: providerType,
      name,
      provider_type: providerType,
    });
  };

  // Only add the configured model if its provider is actually reachable
  // (has keys/env configured). Otherwise we'd show models the user can't use.
  const configuredProviderIsConfigured = listConfiguredPiProviders(
    providerNames,
  ).includes(configured.provider);
  if (
    isPiProviderForLocalModelHandle(configured.provider) &&
    !isDiscoverableLocalProvider(configured.provider) &&
    !modelsRuntime.isRuntimeManagedProvider(configured.provider) &&
    configuredProviderIsConfigured
  ) {
    addModel(configured.provider, configured.model);
  }
  const configuredProviders = new Set(listConfiguredPiProviders(providerNames));
  // One discovery projection for every provider class: configured built-ins,
  // auto-detectable local endpoints, and configured mod registrations all
  // resolve through the runtime-managed branch below or the runtime catalog.
  const providersToDiscover = new Set<PiProvider | string>([
    ...configuredProviders,
    ...PI_PROVIDER_SPECS.filter((provider) =>
      isAutoDetectableLocalEndpointProvider(provider.id),
    ).map((provider) => provider.id),
    ...registeredProviders
      .filter((provider) => isRegisteredPiProviderConfigured(provider, records))
      .map((provider) => provider.providerName),
  ]);
  const discoveryResults = await Promise.all(
    [...providersToDiscover].map(
      async (
        provider,
      ): Promise<{
        provider: PiProvider | string;
        models: string[];
        runtimeModels?: readonly Model<Api>[];
      }> => {
        if (modelsRuntime.isRuntimeManagedProvider(provider)) {
          return {
            provider,
            models: [],
            runtimeModels: modelsRuntime.getModels(provider),
          };
        }

        return {
          provider,
          models: catalogHandlesForProvider(
            provider as PiProvider,
            modelsRuntime,
          ),
        };
      },
    ),
  );

  for (const result of discoveryResults) {
    for (const model of result.models) {
      addModel(result.provider, model);
    }
    for (const model of result.runtimeModels ?? []) {
      // A mod registration keeps its own name as the provider type, even
      // when it overrides a built-in provider id.
      const registeredName = getRegisteredPiProvider(result.provider)
        ? String(result.provider)
        : undefined;
      addModel(result.provider, model.id, {
        ...(registeredName
          ? {
              handle: `${registeredName}/${model.id}`,
              modelEndpointType: registeredName,
            }
          : {}),
        maxContextWindow: model.contextWindow,
        maxOutputTokens: model.maxTokens,
        name: model.name,
      });
    }
  }
  return models;
}
