import {
  type AISDKProvider,
  DEFAULT_AI_SDK_PROVIDER,
} from "../dev/AISDKModelFactory";
import {
  listCatalogModelsForProvider,
  listConfiguredAISDKProviders,
  localModelHandle,
  localProviderType,
  resolveLocalModel,
} from "../dev/AISDKProviderRegistry";
import { listLocalProviderRecords } from "./LocalProviderAuthStore";

export interface LocalModelConfig {
  provider: AISDKProvider;
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

export function resolveLocalProvider(storageDir?: string): AISDKProvider {
  return (
    listConfiguredAISDKProviders(localProviderNames(storageDir))[0] ??
    DEFAULT_AI_SDK_PROVIDER
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
  const addModel = (provider: AISDKProvider, model: string) => {
    const handle = localModelHandle(provider, model);
    if (models.some((entry) => entry.handle === handle)) return;
    models.push({
      handle,
      model: handle,
      model_endpoint_type: localProviderType(provider),
    });
  };

  addModel(configured.provider, configured.model);
  for (const provider of listConfiguredAISDKProviders(
    localProviderNames(storageDir),
  )) {
    for (const model of listCatalogModelsForProvider(provider)) {
      addModel(provider, model);
    }
  }
  return models;
}
