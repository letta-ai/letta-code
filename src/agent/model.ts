/**
 * Model resolution and handling utilities
 */
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";
import { getDefaultModel, models, resolveModel } from "./model-catalog";

// Pure catalog lookups live in model-catalog.ts (bundled into the
// agent-presets package export); re-exported here so CLI code keeps a single
// import surface for model utilities.
export { getDefaultModel, models, resolveModel };

export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

type ModelConfigSnapshot = {
  model?: string | null;
  model_endpoint_type?: string | null;
  reasoning_effort?: string | null;
  enable_reasoner?: boolean | null;
  context_window?: number | null;
  service_tier?: string | null;
};

const REASONING_EFFORT_ORDER: ModelReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const LOCAL_REASONING_EFFORT_ORDER: ModelReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
];

const LOCAL_MODEL_HANDLE_PREFIXES = [
  "ollama/",
  "ollama-cloud/",
  "lmstudio/",
  "llama.cpp/",
  "llama-cpp/",
];

const LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX = "openai-codex/";
const CHATGPT_OAUTH_LLM_CONFIG_PROVIDER = "chatgpt_oauth";
export const CHATGPT_FAST_SERVICE_TIER = "priority";

export function isLocalModelHandle(modelHandle: string): boolean {
  return LOCAL_MODEL_HANDLE_PREFIXES.some((prefix) =>
    modelHandle.startsWith(prefix),
  );
}

export function getLocalModelLabel(modelHandle: string): string {
  const providerPrefix = LOCAL_MODEL_HANDLE_PREFIXES.find((prefix) =>
    modelHandle.startsWith(prefix),
  );
  return providerPrefix
    ? modelHandle.slice(providerPrefix.length)
    : modelHandle;
}

function isModelReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return (
    typeof value === "string" &&
    REASONING_EFFORT_ORDER.includes(value as ModelReasoningEffort)
  );
}

export function normalizeModelHandleForRegistry(
  modelHandle: string | null | undefined,
): string | null {
  if (!modelHandle) return null;
  const [provider, ...modelParts] = modelHandle.split("/");
  const model = modelParts.join("/");
  if (provider === CHATGPT_OAUTH_LLM_CONFIG_PROVIDER && model.length > 0) {
    return `${OPENAI_CODEX_PROVIDER_NAME}/${model}`;
  }
  if (
    provider === LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX.slice(0, -1) &&
    model.length > 0 &&
    !model.endsWith("-fast")
  ) {
    return `${OPENAI_CODEX_PROVIDER_NAME}/${model}`;
  }
  if (provider === "lc-anthropic" && model.length > 0) {
    return `anthropic/${model}`;
  }
  return modelHandle;
}

function modelPortion(modelHandle: string): string | null {
  const slashIndex = modelHandle.indexOf("/");
  if (slashIndex === -1) return null;
  return modelHandle.slice(slashIndex + 1);
}

export function isLocalChatGptOAuthModelHandle(modelHandle: string): boolean {
  return modelHandle.startsWith(LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX);
}

export function getChatGptFastRegistryHandleForModelHandle(
  modelHandle: string,
): string | null {
  const [provider] = modelHandle.split("/");
  if (
    provider !== LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX.slice(0, -1) &&
    provider !== CHATGPT_OAUTH_LLM_CONFIG_PROVIDER &&
    provider !== OPENAI_CODEX_PROVIDER_NAME
  ) {
    return null;
  }
  const normalized = normalizeModelHandleForRegistry(modelHandle);
  if (!normalized?.startsWith(`${OPENAI_CODEX_PROVIDER_NAME}/`)) return null;
  const model = modelPortion(normalized);
  if (!model || model.endsWith("-fast")) return null;
  const fastHandle = `${OPENAI_CODEX_PROVIDER_NAME}/${model}-fast`;
  return models.some((entry) => entry.handle === fastHandle)
    ? fastHandle
    : null;
}

function displayRegistryHandleForServiceTier(
  modelHandle: string,
  serviceTier?: string | null,
): string {
  if (serviceTier === CHATGPT_FAST_SERVICE_TIER) {
    return (
      getChatGptFastRegistryHandleForModelHandle(modelHandle) ?? modelHandle
    );
  }
  return normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
}

export function getReasoningTierOptionsForHandle(
  modelHandle: string,
  contextWindow?: number,
): Array<{
  effort: ModelReasoningEffort;
  modelId: string;
}> {
  const byEffort = new Map<ModelReasoningEffort, string>();
  const registryHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  const effectiveContextWindow =
    contextWindow ??
    (() => {
      const contextWindows = models
        .filter((model) => model.handle === registryHandle)
        .map(
          (model) =>
            (model.updateArgs as { context_window?: number } | null)
              ?.context_window,
        )
        .filter((value): value is number => typeof value === "number");
      const uniqueContextWindows = [...new Set(contextWindows)];
      return uniqueContextWindows.length > 1
        ? Math.min(...uniqueContextWindows)
        : undefined;
    })();

  for (const model of models) {
    if (model.handle !== registryHandle) continue;
    if (effectiveContextWindow !== undefined) {
      const mCtx = (model.updateArgs as { context_window?: number } | null)
        ?.context_window;
      if (mCtx !== effectiveContextWindow) continue;
    }
    const effort = (model.updateArgs as { reasoning_effort?: unknown } | null)
      ?.reasoning_effort;
    if (!isModelReasoningEffort(effort)) continue;
    if (!byEffort.has(effort)) {
      byEffort.set(effort, model.id);
    }
  }

  if (byEffort.size === 0 && isLocalModelHandle(registryHandle)) {
    return LOCAL_REASONING_EFFORT_ORDER.map((effort) => ({
      effort,
      modelId: registryHandle,
    }));
  }

  return REASONING_EFFORT_ORDER.flatMap((effort) => {
    const modelId = byEffort.get(effort);
    return modelId ? [{ effort, modelId }] : [];
  });
}

/**
 * Get the default model handle based on billing tier.
 * All tiers use the same default selection path.
 * @param billingTier - The user's billing tier (e.g., "free", "pro", "enterprise")
 * @returns The model handle to use as default
 */
export function getDefaultModelForTier(billingTier?: string | null): string {
  void billingTier;
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

  const normalizedHandle = normalizeModelHandleForRegistry(modelIdentifier);
  const byHandle = models.find((m) => m.handle === normalizedHandle);
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
    context_window?: number | null;
    service_tier?: string | null;
  } | null,
) {
  const registryHandle = displayRegistryHandleForServiceTier(
    modelHandle,
    llmConfig?.service_tier ?? null,
  );
  // Try ID/handle direct resolution first.
  const direct = getModelInfo(registryHandle);

  // Collect all candidates that share this handle.
  let candidates = models.filter((m) => m.handle === registryHandle);
  if (candidates.length === 0) {
    return direct;
  }

  // When context_window is known, narrow candidates to the matching tier
  // so that e.g. 1M variants don't collapse into 200k variants.
  let narrowedByCtx = false;
  const ctxWindow = llmConfig?.context_window ?? null;
  if (ctxWindow !== null) {
    const ctxMatches = candidates.filter(
      (m) =>
        (m.updateArgs as { context_window?: number } | undefined)
          ?.context_window === ctxWindow,
    );
    if (ctxMatches.length > 0) {
      candidates = ctxMatches;
      narrowedByCtx = true;
    }
  }

  const effort = llmConfig?.reasoning_effort ?? null;
  if (effort) {
    const match = candidates.find(
      (m) =>
        (m.updateArgs as { reasoning_effort?: unknown } | undefined)
          ?.reasoning_effort === effort,
    );
    if (match) return match;

    if (effort === "max") {
      const legacyXHighMatch = candidates.find(
        (m) =>
          (m.updateArgs as { reasoning_effort?: unknown } | undefined)
            ?.reasoning_effort === "xhigh",
      );
      if (legacyXHighMatch) return legacyXHighMatch;
    }
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

  // When candidates were narrowed by context_window, prefer the narrowed set
  // over `direct` (which is the first model with this handle — always the 200k
  // variant — and ignores context_window entirely).
  if (narrowedByCtx) {
    return candidates[0] ?? direct ?? null;
  }
  return direct ?? candidates[0] ?? null;
}

function buildModelHandleFromConfig(
  config: ModelConfigSnapshot | null | undefined,
): string | null {
  if (!config) return null;
  if (config.model_endpoint_type && config.model) {
    return `${config.model_endpoint_type}/${config.model}`;
  }
  return config.model ?? null;
}

export function shouldPreserveContextWindowForModelSelection(input: {
  currentModelHandle?: string | null;
  currentModelId?: string | null;
  currentLlmConfig?: ModelConfigSnapshot | null;
  selectedModelHandle: string;
  selectedContextWindow?: number;
}): boolean {
  const currentRegistryModelHandle = normalizeModelHandleForRegistry(
    input.currentModelHandle ??
      buildModelHandleFromConfig(input.currentLlmConfig),
  );
  const selectedRegistryModelHandle = normalizeModelHandleForRegistry(
    input.selectedModelHandle,
  );

  if (
    selectedRegistryModelHandle === null ||
    selectedRegistryModelHandle !== currentRegistryModelHandle
  ) {
    return false;
  }

  const currentModelInfo = input.currentModelId
    ? getModelInfo(input.currentModelId)
    : currentRegistryModelHandle
      ? getModelInfoForLlmConfig(
          currentRegistryModelHandle,
          input.currentLlmConfig,
        )
      : null;
  const currentPresetContextWindow = (
    currentModelInfo?.updateArgs as { context_window?: unknown } | undefined
  )?.context_window;

  return (
    typeof input.selectedContextWindow !== "number" ||
    (typeof currentPresetContextWindow === "number" &&
      input.selectedContextWindow === currentPresetContextWindow) ||
    (typeof currentPresetContextWindow !== "number" &&
      input.selectedContextWindow === input.currentLlmConfig?.context_window)
  );
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
    if (
      field === "max_output_tokens" &&
      (typeof value === "number" || value === null)
    ) {
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
  const wantMaxTokens = updateArgs.max_output_tokens as
    | number
    | null
    | undefined;
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

  const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;

  // Try exact match first
  const exactMatch = models.find((m) => m.handle === registryHandle);
  if (exactMatch) return exactMatch;

  // For handles like "bedrock/claude-opus-4-5-20251101" where the API returns without
  // vendor prefix or version suffix, but models.json has
  // "bedrock/us.anthropic.claude-opus-4-5-20251101-v1:0", try fuzzy matching
  const [provider, ...rest] = registryHandle.split("/");
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
