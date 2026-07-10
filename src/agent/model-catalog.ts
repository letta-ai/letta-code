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
