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

/** Resolve a model by ID or handle. */
export function resolveModel(modelIdentifier: string): string | null {
  const byId = models.find((model) => model.id === modelIdentifier);
  if (byId) return byId.handle;

  const byHandle = models.find((model) => model.handle === modelIdentifier);
  if (byHandle) return byHandle.handle;

  const builtinHandle = BUILTIN_MODEL_ALIASES.get(modelIdentifier);
  if (builtinHandle) return builtinHandle;

  // Local pi-ai catalogs use provider-native model IDs as their short names.
  // Resolve one only when it identifies exactly one handle.
  const matchingHandles = new Set(
    models
      .filter(
        (model) =>
          model.handle.split("/").slice(1).join("/") === modelIdentifier,
      )
      .map((model) => model.handle),
  );
  if (matchingHandles.size === 1) {
    return matchingHandles.values().next().value ?? null;
  }

  // Runtime/custom catalogs can contain handles not known before startup.
  if (modelIdentifier.includes("/")) {
    return modelIdentifier;
  }

  return null;
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
