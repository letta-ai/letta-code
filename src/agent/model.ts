/**
 * Model resolution and handling utilities
 */
import modelsData from "../models.json";

export const models = modelsData;

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

  return null;
}

/**
 * Get the default model handle
 */
export function getDefaultModel(): string {
  const defaultModel = models.find((m) => m.isDefault);
  if (defaultModel) return defaultModel.handle;

  const firstModel = models[0];
  if (!firstModel) {
    throw new Error("No models available in models.json");
  }
  return firstModel.handle;
}

/**
 * Format available models for error messages
 */
export function formatAvailableModels(): string {
  return models.map((m) => `  ${m.id.padEnd(20)} ${m.handle}`).join("\n");
}

/**
 * Get model info by ID or handle
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The model info if found, null otherwise
 */
export function getModelInfo(modelIdentifier: string) {
  const byId = models.find((m) => m.id === modelIdentifier);
  if (byId) return byId;

  const byHandle = models.find((m) => m.handle === modelIdentifier);
  if (byHandle) return byHandle;

  return null;
}

/**
 * Get updateArgs for a model by ID or handle
 * @param modelIdentifier - Can be either a model ID (e.g., "opus-4.5") or a full handle (e.g., "anthropic/claude-opus-4-5")
 * @returns The updateArgs if found, undefined otherwise
 */
export function getModelUpdateArgs(
  modelIdentifier?: string,
): Record<string, unknown> | undefined {
  if (!modelIdentifier) return undefined;
  const modelInfo = getModelInfo(modelIdentifier);
  return modelInfo?.updateArgs;
}

/**
 * Find a model entry by handle with fuzzy matching support
 * @param handle - The full model handle
 * @returns The model entry if found, null otherwise
 */
function findModelByHandle(handle: string): (typeof models)[number] | null {
  // Try exact match first
  const exactMatch = models.find((m) => m.handle === handle);
  if (exactMatch) return exactMatch;

  // For handles like "bedrock/claude-opus-4-5-20251101" where the API returns without
  // vendor prefix or version suffix, but models.json has
  // "bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0", try fuzzy matching
  const [provider, ...rest] = handle.split("/");
  if (provider && rest.length > 0) {
    const modelPortion = rest.join("/");
    // Find models with the same provider where the model portion is contained
    // in the models.json handle (handles vendor prefixes and version suffixes)
    const partialMatch = models.find((m) => {
      if (!m.handle.startsWith(`${provider}/`)) return false;
      const mModelPortion = m.handle.slice(provider.length + 1);
      // Check if either contains the other (handles both directions)
      return (
        mModelPortion.includes(modelPortion) ||
        modelPortion.includes(mModelPortion)
      );
    });
    if (partialMatch) return partialMatch;
  }

  return null;
}

/**
 * Get a display-friendly name for a model by its handle
 * @param handle - The full model handle (e.g., "anthropic/claude-sonnet-4-5-20250929")
 * @returns The display name (e.g., "Sonnet 4.5") if found, null otherwise
 */
export function getModelDisplayName(handle: string): string | null {
  const model = findModelByHandle(handle);
  return model?.label ?? null;
}

/**
 * Get a short display name for a model (for status bar)
 * Falls back to full label if no shortLabel is defined
 * @param handle - The full model handle
 * @returns The short name (e.g., "Opus 4.5 BR") if found, null otherwise
 */
export function getModelShortName(handle: string): string | null {
  const model = findModelByHandle(handle);
  if (!model) return null;
  // Use shortLabel if available, otherwise fall back to label
  return (model as { shortLabel?: string }).shortLabel ?? model.label;
}

/**
 * Resolve a model ID from the llm_config.model value
 * The llm_config.model is the model portion without the provider prefix
 * (e.g., "z-ai/glm-4.6:exacto" for handle "openrouter/z-ai/glm-4.6:exacto")
 *
 * Note: This may not distinguish between variants like gpt-5.2-medium vs gpt-5.2-high
 * since they share the same handle. For provider fallback, this is acceptable.
 *
 * @param llmConfigModel - The model value from agent.llm_config.model
 * @returns The model ID if found, null otherwise
 */
export function resolveModelByLlmConfig(llmConfigModel: string): string | null {
  // Try to find a model whose handle ends with the llm_config model value
  const match = models.find((m) => m.handle.endsWith(`/${llmConfigModel}`));
  if (match) return match.id;

  // Also try exact match on the model portion (for simple cases like "gpt-5.2")
  const exactMatch = models.find((m) => {
    const parts = m.handle.split("/");
    return parts.slice(1).join("/") === llmConfigModel;
  });
  if (exactMatch) return exactMatch.id;

  return null;
}
