import type { AvailableModel } from "@/agent/available-models";
import { models } from "@/agent/model";
import { resolvePiModelIdentity } from "@/backend/dev/pi-provider-registry";
import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";

function buildPresetEntry(
  model: (typeof models)[number],
): ListModelsResponseModelEntry {
  return {
    id: model.id,
    handle: model.handle,
    label: model.label,
    description: model.description,
    ...(typeof model.isDefault === "boolean"
      ? { isDefault: model.isDefault }
      : {}),
    ...(typeof model.isFeatured === "boolean"
      ? { isFeatured: model.isFeatured }
      : {}),
    ...(typeof model.free === "boolean" ? { free: model.free } : {}),
    ...(model.updateArgs && typeof model.updateArgs === "object"
      ? { updateArgs: model.updateArgs as Record<string, unknown> }
      : {}),
  };
}

export function availableModelUpdateArgs(
  model: AvailableModel | undefined,
): Record<string, unknown> | undefined {
  if (!model?.openAICompatibleProxy) {
    return model?.providerType &&
      (model.providerCategory === "byok" ||
        model.providerType === "chatgpt_oauth")
      ? { provider_type: model.providerType }
      : undefined;
  }
  return {
    provider_type: "openai",
    [OPENAI_COMPATIBLE_PROXY_UPDATE_ARG]: true,
  };
}

function withAvailableModelMetadata(
  entry: ListModelsResponseModelEntry,
  model: AvailableModel,
): ListModelsResponseModelEntry {
  const availableUpdateArgs = availableModelUpdateArgs(model);
  return {
    ...entry,
    handle: model.handle,
    ...(availableUpdateArgs
      ? { updateArgs: { ...(entry.updateArgs ?? {}), ...availableUpdateArgs } }
      : {}),
  };
}

export function buildNativeModelEntry(
  model: AvailableModel,
): ListModelsResponseModelEntry {
  // A BYOK provider name is organization-specific. Match metadata by route
  // type and model name, but never replace its execution handle or selector ID.
  const preset =
    model.providerCategory === "byok" && model.providerType
      ? models.find(
          (entry) =>
            (entry.updateArgs?.provider_type ?? entry.handle.split("/")[0]) ===
              model.providerType &&
            entry.handle.slice(entry.handle.indexOf("/") + 1) ===
              model.handle.slice(model.handle.indexOf("/") + 1),
        )
      : undefined;
  const updateArgs = {
    ...(preset?.updateArgs ?? {}),
    ...(availableModelUpdateArgs(model) ?? {}),
  };
  return {
    id: model.handle,
    handle: model.handle,
    label: preset?.label ?? model.label,
    description: preset?.description ?? "",
    ...(Object.keys(updateArgs).length > 0 ? { updateArgs } : {}),
  };
}

function modelIdentity(handle: string): string {
  return resolvePiModelIdentity(handle) ?? handle;
}

export function findAvailableModelForPreset(
  presetHandle: string,
  availableModels: readonly AvailableModel[],
): AvailableModel | undefined {
  return (
    availableModels.find((model) => model.handle === presetHandle) ??
    availableModels.find(
      (model) => modelIdentity(model.handle) === modelIdentity(presetHandle),
    )
  );
}

export function buildListModelsEntries(
  availableModels: readonly AvailableModel[] = [],
  options: { cloud?: boolean } = {},
): ListModelsResponseModelEntry[] {
  const presetEntries = models.map((model) => {
    const entry = buildPresetEntry(model);
    // Cloud hosted presets never depend on the legacy runtime inventory.
    if (options.cloud) return entry;
    const availableModel = findAvailableModelForPreset(
      entry.handle,
      availableModels,
    );
    return availableModel
      ? withAvailableModelMetadata(entry, availableModel)
      : entry;
  });
  const presetHandles = new Set(presetEntries.map((entry) => entry.handle));
  const nativeHandles = new Set<string>();
  const nativeEntries = availableModels.flatMap((model) => {
    if (
      (options.cloud && model.providerCategory !== "byok") ||
      nativeHandles.has(model.handle) ||
      presetHandles.has(model.handle)
    ) {
      return [];
    }
    nativeHandles.add(model.handle);
    return [buildNativeModelEntry(model)];
  });
  return [...presetEntries, ...nativeEntries];
}
