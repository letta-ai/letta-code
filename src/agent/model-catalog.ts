/**
 * The runtime model catalog and pure handle resolution.
 *
 * Cloud mode hydrates this catalog from GET /v1/models/catalog. Local mode
 * hydrates it from the active backend's pi-ai model inventory. Keeping the
 * array identity stable lets synchronous consumers observe source changes
 * without bundling a second, independently-maintained model registry.
 */

/**
 * A model catalog entry shared by cloud presets and local pi-ai models.
 */
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
 * Do not capture long-lived copies of the array contents.
 */
export const models: CatalogModel[] = [];

const BUILTIN_MODEL_ALIASES = new Map([
  ["auto", "letta/auto"],
  ["auto-chat", "letta/auto-chat"],
  ["auto-fast", "letta/auto-fast"],
]);

/**
 * Resolve a model by ID or handle
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The model handle if found, null otherwise
 */
export function resolveModel(modelIdentifier: string): string | null {
  const byId = models.find((m) => m.id === modelIdentifier);
  if (byId) return byId.handle;

  const byHandle = models.find((m) => m.handle === modelIdentifier);
  if (byHandle) return byHandle.handle;

  const builtinHandle = BUILTIN_MODEL_ALIASES.get(modelIdentifier);
  if (builtinHandle) return builtinHandle;

  // Local pi-ai catalogs use provider-native model IDs as their short names.
  // Only resolve a model portion when it identifies exactly one handle.
  const matchingHandles = new Set(
    models
      .filter(
        (model) =>
          model.handle.split("/").slice(1).join("/") === modelIdentifier,
      )
      .map((model) => model.handle),
  );
  if (matchingHandles.size === 1) {
    return [...matchingHandles][0] ?? null;
  }

  // Runtime/custom catalogs can contain handles not known at process startup.
  if (modelIdentifier.includes("/")) {
    return modelIdentifier;
  }

  return null;
}

/**
 * Get the default model handle
 */
export function getDefaultModel(): string {
  if (models.length === 0) {
    return BUILTIN_MODEL_ALIASES.get("auto") ?? "letta/auto";
  }
  // Prefer the managed Auto alias when the active catalog offers it.
  const autoModel = resolveModel("auto");
  if (autoModel && models.some((model) => model.handle === autoModel)) {
    return autoModel;
  }

  const defaultModel = models.find((m) => m.isDefault);
  if (defaultModel) return defaultModel.handle;

  // Local mode deliberately has no curated default; letta/auto tells the
  // local backend to use its configured Pi provider/model.
  return BUILTIN_MODEL_ALIASES.get("auto") ?? "letta/auto";
}
