/**
 * The runtime model catalog and pure handle resolution.
 *
 * Cloud mode hydrates this catalog from GET /v1/models/catalog. Local mode
 * hydrates it from the active backend's pi-ai model inventory. Keeping the
 * array identity stable lets synchronous consumers observe source changes
 * without bundling a second model registry.
 */

/** A model catalog entry shared by cloud presets and local pi-ai models. */
export interface CatalogModel {
  id: string;
  handle: string;
  label: string;
  description: string;
  shortLabel?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
}

/**
 * The live model catalog. Startup initializes it before model resolution:
 * cloud backends use GET /v1/models/catalog and local backends use pi-ai.
 * Source changes replace the contents in place, so consumers that read at
 * call time pick up current data without capturing a stale array reference.
 */
export const models: CatalogModel[] = [];

const BUILTIN_MODEL_ALIASES = new Map([
  ["auto", "letta/auto"],
  ["auto-chat", "letta/auto-chat"],
  ["auto-fast", "letta/auto-fast"],
]);

function resolveEstablishedCliAlias(
  modelIdentifier: string,
): CatalogModel | null {
  if (modelIdentifier === "haiku") {
    return (
      models.find((model) => model.handle.includes("claude-haiku-4-5")) ?? null
    );
  }
  if (modelIdentifier === "sonnet-4.6-low") {
    const matchingModels = models.filter((model) =>
      model.handle.includes("claude-sonnet-4-6"),
    );
    const lowEffortModel = matchingModels.find(
      (model) => model.updateArgs?.reasoning_effort === "low",
    );
    if (lowEffortModel) return lowEffortModel;
    const baseModel = matchingModels[0];
    return baseModel
      ? {
          ...baseModel,
          id: modelIdentifier,
          updateArgs: {
            ...baseModel.updateArgs,
            reasoning_effort: "low",
            enable_reasoner: true,
          },
        }
      : null;
  }
  return null;
}

/** Resolve a model catalog entry by runtime ID, handle, or CLI alias. */
export function resolveCatalogModel(
  modelIdentifier: string,
): CatalogModel | null {
  const byId = models.find((model) => model.id === modelIdentifier);
  if (byId) return byId;

  const byHandle = models.find((model) => model.handle === modelIdentifier);
  if (byHandle) return byHandle;

  const cliAlias = resolveEstablishedCliAlias(modelIdentifier);
  if (cliAlias) return cliAlias;

  // Runtime catalogs use provider-native model IDs as their short names.
  // Resolve one only when it identifies exactly one handle.
  const matches = models.filter(
    (model) => model.handle.split("/").slice(1).join("/") === modelIdentifier,
  );
  const matchingHandles = new Set(matches.map((model) => model.handle));
  return matchingHandles.size === 1 ? (matches[0] ?? null) : null;
}

/** Resolve a model by ID or handle. */
export function resolveModel(modelIdentifier: string): string | null {
  const entry = resolveCatalogModel(modelIdentifier);
  if (entry) return entry.handle;

  const builtinHandle = BUILTIN_MODEL_ALIASES.get(modelIdentifier);
  if (builtinHandle) return builtinHandle;

  // Runtime/custom catalogs can contain handles not known before startup.
  return modelIdentifier.includes("/") ? modelIdentifier : null;
}

/** Get the default model handle from the active catalog. */
export function getDefaultModel(): string {
  if (models.length === 0) return "letta/auto";

  const autoModel = models.find((model) => model.id === "auto");
  if (autoModel) return autoModel.handle;

  const defaultModel = models.find((model) => model.isDefault);
  if (defaultModel) return defaultModel.handle;

  const firstModel = models[0];
  if (!firstModel) {
    throw new Error("Model catalog is unavailable.");
  }
  return firstModel.handle;
}
