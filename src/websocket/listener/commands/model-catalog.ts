import type { AvailableModel } from "@/agent/available-models";
import { models } from "@/agent/model";
import { resolvePiModelIdentity } from "@/backend/dev/pi-provider-registry";
import type { ListModelsResponseModelEntry } from "@/types/protocol_v2";

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

function buildNativeEntry(model: AvailableModel): ListModelsResponseModelEntry {
  return {
    id: model.handle,
    handle: model.handle,
    label: model.label,
    description: "",
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
): ListModelsResponseModelEntry[] {
  const presetEntries = models.map((model) => {
    const entry = buildPresetEntry(model);
    const availableModel = findAvailableModelForPreset(
      entry.handle,
      availableModels,
    );
    return availableModel ? { ...entry, handle: availableModel.handle } : entry;
  });
  const presetHandles = new Set(presetEntries.map((entry) => entry.handle));
  const nativeHandles = new Set<string>();
  const nativeEntries = availableModels.flatMap((model) => {
    if (nativeHandles.has(model.handle) || presetHandles.has(model.handle)) {
      return [];
    }
    nativeHandles.add(model.handle);
    return [buildNativeEntry(model)];
  });
  return [...presetEntries, ...nativeEntries];
}
