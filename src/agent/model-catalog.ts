/**
 * The static model catalog (models.json) and pure handle resolution.
 *
 * Split from `model.ts` so the catalog can be bundled into the browser-safe
 * `@letta-ai/letta-code/agent-presets` package export without dragging in
 * provider/backend modules. CLI code should keep importing from
 * `@/agent/model`, which re-exports this module.
 */

import modelsData from "@/models.json";

export const models = modelsData.models;

/**
 * Browser-safe presentation metadata for a curated Letta Code model preset.
 *
 * This is deliberately not an availability contract: connected providers,
 * local/custom models, and organization-specific hosted inventory remain
 * runtime concerns. Consumers may use presets for labels, descriptions,
 * ordering, and known settings while live API/device inventory decides what
 * is actually selectable.
 */
export interface ModelPreset {
  readonly id: string;
  readonly handle: string;
  readonly label: string;
  readonly description: string;
  readonly shortLabel?: string;
  readonly isDefault?: boolean;
  readonly isFeatured?: boolean;
  readonly free?: boolean;
  readonly updateArgs?: Readonly<Record<string, unknown>>;
}

/**
 * Curated model presentation presets bundled with Letta Code.
 *
 * Runtime model inventory is authoritative for availability. This export is
 * a readonly view over the same catalog used by the CLI's model resolver.
 */
export const MODEL_PRESETS: readonly ModelPreset[] = models;

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

  // For self-hosted servers: if it looks like a handle (contains /), pass it through
  // This allows using models not in models.json (e.g., from server's /v1/models)
  if (modelIdentifier.includes("/")) {
    return modelIdentifier;
  }

  return null;
}

/**
 * Get the default model handle
 */
export function getDefaultModel(): string {
  // Prefer Auto when available in models.json.
  const autoModel = resolveModel("auto");
  if (autoModel) return autoModel;

  const defaultModel = models.find((m) => m.isDefault);
  if (defaultModel) return defaultModel.handle;

  const firstModel = models[0];
  if (!firstModel) {
    throw new Error("No models available in models.json");
  }
  return firstModel.handle;
}
