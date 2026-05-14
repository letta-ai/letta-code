import { DEFAULT_PI_PROVIDER, type PiProvider } from "../dev/PiModelFactory";
import {
  listCatalogModelsForProvider,
  listConfiguredPiProviders,
  localModelHandle,
  localProviderType,
  resolveLocalModel,
} from "../dev/PiProviderRegistry";
import { listLocalProviderRecords } from "./LocalProviderAuthStore";

export interface LocalModelConfig {
  provider: PiProvider;
  model: string;
  handle: string;
  modelSettings: Record<string, unknown>;
}

interface LocalModelListEntry {
  handle: string;
  model: string;
  model_endpoint_type: string;
}

function localProviderNames(storageDir?: string): Set<string> {
  return new Set(
    listLocalProviderRecords(storageDir).map((record) => record.name),
  );
}

export function resolveLocalProvider(storageDir?: string): PiProvider {
  return (
    listConfiguredPiProviders(localProviderNames(storageDir))[0] ??
    DEFAULT_PI_PROVIDER
  );
}

export { localModelHandle, localProviderType, resolveLocalModel };

export function resolveLocalModelConfig(storageDir?: string): LocalModelConfig {
  const provider = resolveLocalProvider(storageDir);
  const model = resolveLocalModel(provider);
  return {
    provider,
    model,
    handle: localModelHandle(provider, model),
    modelSettings: { provider_type: localProviderType(provider) },
  };
}

export function listLocalModels(storageDir?: string) {
  const configured = resolveLocalModelConfig(storageDir);
  const models: LocalModelListEntry[] = [];
  const addModel = (provider: PiProvider, model: string) => {
    const handle = localModelHandle(provider, model);
    if (models.some((entry) => entry.handle === handle)) return;
    models.push({
      handle,
      model: handle,
      model_endpoint_type: localProviderType(provider),
    });
  };

  addModel(configured.provider, configured.model);
  for (const provider of listConfiguredPiProviders(
    localProviderNames(storageDir),
  )) {
    for (const model of listCatalogModelsForProvider(provider)) {
      addModel(provider, model);
    }
  }
  return models;
}
