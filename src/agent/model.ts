/**
 * Model resolution and handling utilities
 */
import modelsData from "../models.json";
import { OPENAI_CODEX_PROVIDER_NAME } from "../providers/openai-codex-provider";

export const models = modelsData;

export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

const REASONING_EFFORT_ORDER: ModelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === "string" &&
    REASONING_EFFORT_ORDER.includes(value as ModelReasoningEffort)
  );
}

export function getReasoningTierOptionsForHandle(modelHandle: string): Array<{
  effort: ModelReasoningEffort;
  modelId: string;
}> {
  const byEffort = new Map<ModelReasoningEffort, string>();

  for (const model of models) {
    if (model.handle !== modelHandle) continue;
    const effort = (model.updateArgs as { reasoning_effort?: unknown } | null)
      ?.reasoning_effort;
    if (!isModelReasoningEffort(effort)) continue;
    if (!byEffort.has(effort)) {
      byEffort.set(effort, model.id);
    }
  }

  return REASONING_EFFORT_ORDER.flatMap((effort) => {
    const modelId = byEffort.get(effort);
    return modelId ? [{ effort, modelId }] : [];
  });
}

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
  const defaultModel = models.find((m) => m.isDefault);
  if (defaultModel) return defaultModel.handle;

  const firstModel = models[0];
  if (!firstModel) {
    throw new Error("No models available in models.json");
  }
  return firstModel.handle;
}

/**
 * Get the default model handle based on billing tier.
 * Free tier users get glm-4.7, everyone else gets the standard default.
 * @param billingTier - The user's billing tier (e.g., "free", "pro", "enterprise")
 * @returns The model handle to use as default
 */
export function getDefaultModelForTier(billingTier?: string | null): string {
  // Free tier gets glm-4.7 (a free model)
  if (billingTier?.toLowerCase() === "free") {
    const freeDefault = models.find((m) => m.id === "glm-4.7");
    if (freeDefault) return freeDefault.handle;
  }
  // Everyone else (pro, enterprise, unknown) gets the standard default
  return getDefaultModel();
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
 * Get model info by handle + llm_config.
 *
 * This exists because many model "tiers" (e.g. gpt-5.2-none/low/medium/high)
 * share the same handle and differ only by updateArgs like reasoning_effort.
 *
 * When resuming a session we want `/model` to highlight the tier that actually
 * matches the agent configuration.
 */
export function getModelInfoForLlmConfig(
  modelHandle: string,
  llmConfig?: {
    reasoning_effort?: string | null;
    enable_reasoner?: boolean | null;
  } | null,
) {
  // Try ID/handle direct resolution first.
  const direct = getModelInfo(modelHandle);

  // Collect all candidates that share this handle.
  const candidates = models.filter((m) => m.handle === modelHandle);
  if (candidates.length === 0) {
    return direct;
  }

  const effort = llmConfig?.reasoning_effort ?? null;
  if (effort) {
    const match = candidates.find(
      (m) =>
        (m.updateArgs as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort === effort,
    );
    if (match) return match;
  }

  // Anthropic-style toggle (best-effort; llm_config may not always include it)
  if (llmConfig?.enable_reasoner === false) {
    const match = candidates.find(
      (m) =>
        (m.updateArgs as { enable_reasoner?: unknown } | undefined)
          ?.enable_reasoner === false,
    );
    if (match) return match;
  }

  // Fall back to whatever models.json considers the default for this handle.
  return direct ?? candidates[0] ?? null;
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

type AgentModelSnapshot = {
  model?: string | null;
  llm_config?: {
    model?: string | null;
    model_endpoint_type?: string | null;
    reasoning_effort?: string | null;
    enable_reasoner?: boolean | null;
  } | null;
};

/**
 * Resolve the current model preset + updateArgs for an existing agent.
 *
 * Used during startup/resume refresh to re-apply only preset-defined fields
 * (without requiring an explicit --model flag).
 */
export function getModelPresetUpdateForAgent(
  agent: AgentModelSnapshot,
): { modelHandle: string; updateArgs: Record<string, unknown> } | null {
  const directHandle =
    typeof agent.model === "string" && agent.model.length > 0
      ? agent.model
      : null;

  const endpointType = agent.llm_config?.model_endpoint_type;
  const llmModel = agent.llm_config?.model;
  const llmDerivedHandle =
    typeof endpointType === "string" &&
    endpointType.length > 0 &&
    typeof llmModel === "string" &&
    llmModel.length > 0
      ? `${
          endpointType === "chatgpt_oauth"
            ? OPENAI_CODEX_PROVIDER_NAME
            : endpointType
        }/${llmModel}`
      : typeof llmModel === "string" && llmModel.includes("/")
        ? llmModel
        : null;

  const modelHandle = directHandle ?? llmDerivedHandle;
  if (!modelHandle) return null;

  const modelInfo = getModelInfoForLlmConfig(modelHandle, {
    reasoning_effort: agent.llm_config?.reasoning_effort ?? null,
    enable_reasoner: agent.llm_config?.enable_reasoner ?? null,
  });

  const updateArgs =
    (modelInfo?.updateArgs as Record<string, unknown> | undefined) ??
    getModelUpdateArgs(modelHandle);

  if (!updateArgs || Object.keys(updateArgs).length === 0) {
    return null;
  }

  return {
    modelHandle: modelInfo?.handle ?? modelHandle,
    updateArgs,
  };
}

/**
 * Fields synced during resume preset refresh.
 * This is the single source of truth for which preset fields are
 * auto-applied on resume and the comparison logic that decides
 * whether an update is needed.
 */
const RESUME_REFRESH_FIELDS = [
  "max_output_tokens",
  "parallel_tool_calls",
] as const;

/**
 * Build the subset of preset updateArgs that should be synced on resume,
 * and check whether the agent already has those values.
 *
 * Returns `{ updateArgs, needsUpdate }`:
 *  - `updateArgs` contains only the resume-scoped fields from the preset.
 *  - `needsUpdate` is false when the agent already matches, so the caller
 *    can skip the expensive PATCH.
 */
export function getResumeRefreshArgs(
  presetUpdateArgs: Record<string, unknown>,
  agent: {
    llm_config?: { max_tokens?: number | null } | null;
    // Accept the broad AgentState union; we only read parallel_tool_calls.
    model_settings?: { parallel_tool_calls?: boolean } | null;
  },
): { updateArgs: Record<string, unknown>; needsUpdate: boolean } {
  const updateArgs: Record<string, unknown> = {};

  // Extract only the resume-scoped fields from the full preset
  for (const field of RESUME_REFRESH_FIELDS) {
    const value = presetUpdateArgs[field];
    if (field === "max_output_tokens" && typeof value === "number") {
      updateArgs[field] = value;
    } else if (field === "parallel_tool_calls" && typeof value === "boolean") {
      updateArgs[field] = value;
    }
  }

  if (Object.keys(updateArgs).length === 0) {
    return { updateArgs, needsUpdate: false };
  }

  // Compare against the agent's current values
  const currentMaxTokens = agent.llm_config?.max_tokens;
  const wantMaxTokens = updateArgs.max_output_tokens as number | undefined;
  const currentParallel = agent.model_settings?.parallel_tool_calls;
  const wantParallel = updateArgs.parallel_tool_calls as boolean | undefined;

  const maxTokensMatch =
    wantMaxTokens === undefined || currentMaxTokens === wantMaxTokens;
  const parallelMatch =
    wantParallel === undefined || currentParallel === wantParallel;

  return { updateArgs, needsUpdate: !(maxTokensMatch && parallelMatch) };
}

/**
 * Find a model entry by handle with fuzzy matching support
 * @param handle - The full model handle
 * @returns The model entry if found, null otherwise
 */
function findModelByHandle(handle: string): (typeof models)[number] | null {
  const pickPreferred = (candidates: (typeof models)[number][]) =>
    candidates.find((m) => m.isDefault) ??
    candidates.find((m) => m.isFeatured) ??
    candidates.find(
      (m) =>
        (m.updateArgs as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort === "medium",
    ) ??
    candidates.find(
      (m) =>
        (m.updateArgs as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort === "high",
    ) ??
    candidates[0] ??
    null;

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
    const providerMatches = models.filter((m) => {
      if (!m.handle.startsWith(`${provider}/`)) return false;
      const mModelPortion = m.handle.slice(provider.length + 1);
      // Check if either contains the other (handles both directions)
      return (
        mModelPortion.includes(modelPortion) ||
        modelPortion.includes(mModelPortion)
      );
    });
    const providerMatch = pickPreferred(providerMatches);
    if (providerMatch) return providerMatch;

    // Cross-provider fallback by model suffix. This helps when llm_config reports
    // provider_type=openai for BYOK models that are represented in models.json
    // under a different provider prefix (e.g. chatgpt-plus-pro/*).
    const suffixMatches = models.filter((m) =>
      m.handle.endsWith(`/${modelPortion}`),
    );
    const suffixMatch = pickPreferred(suffixMatches);
    if (suffixMatch) return suffixMatch;
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
