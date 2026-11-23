import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-constants";
import {
  getDefaultModel,
  models,
  resolveCatalogModel,
  resolveModel,
} from "./model-catalog";
import {
  CHATGPT_OAUTH_LLM_CONFIG_PROVIDER,
  LOCAL_CHATGPT_OAUTH_HANDLE_PREFIX,
  LOCAL_MODEL_HANDLE_PREFIXES,
  type ModelConfigSnapshot,
  modelPortionFromHandle as modelPortion,
  normalizeModelHandleForRegistry,
} from "./model-handles";

export { getDefaultModel, models, resolveModel };
export {
  mapModelHandleToLlmConfigPatch,
  normalizeKnownModelHandle,
  normalizeModelHandleForRegistry,
  resolveModelHandleFromLlmConfig,
} from "./model-handles";

export type ModelReasoningEffort =
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ModelReasoningSelection = ModelReasoningEffort | null;

type ReasoningCapabilities = {
  supported_efforts?: ModelReasoningEffort[] | null;
  mandatory?: boolean;
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
  reasoningCapabilities?: ReasoningCapabilities | null,
): Array<{
  effort: ModelReasoningEffort;
  modelId: string;
}> {
  const providerOptions = getReasoningTierOptionsFromCapabilities(
    modelHandle,
    reasoningCapabilities,
  );
  if (providerOptions.length > 0) return providerOptions;

  const byEffort = new Map<ModelReasoningEffort, string>();
  const normalizedHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  const catalogHandle =
    [...new Set([modelHandle, normalizedHandle])].find((candidate) =>
      models.some((model) => model.handle === candidate),
    ) ?? normalizedHandle;
  const effectiveContextWindow =
    contextWindow ??
    (() => {
      const contextWindows = models
        .filter((model) => model.handle === catalogHandle)
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
    if (model.handle !== catalogHandle) continue;
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

  if (byEffort.size === 0 && isLocalModelHandle(catalogHandle)) {
    return LOCAL_REASONING_EFFORT_ORDER.map((effort) => ({
      effort,
      modelId: catalogHandle,
    }));
  }

  return REASONING_EFFORT_ORDER.flatMap((effort) => {
    const modelId = byEffort.get(effort);
    return modelId ? [{ effort, modelId }] : [];
  });
}

export function getReasoningTierOptionsFromCapabilities(
  modelHandle: string,
  capabilities?: ReasoningCapabilities | null,
): Array<{
  effort: ModelReasoningEffort;
  modelId: string;
}> {
  if (!capabilities) return [];
  const supportedEfforts = new Set<ModelReasoningEffort>(
    capabilities.supported_efforts === null
      ? REASONING_EFFORT_ORDER
      : (capabilities.supported_efforts ?? []),
  );
  return REASONING_EFFORT_ORDER.filter(
    (effort) =>
      supportedEfforts.has(effort) &&
      !(capabilities.mandatory === true && effort === "none"),
  ).map((effort) => ({ effort, modelId: modelHandle }));
}

export function withReasoningEffortUpdateArg(
  updateArgs: Record<string, unknown> | undefined,
  reasoningEffort: ModelReasoningSelection | undefined,
): Record<string, unknown> | undefined {
  if (reasoningEffort === undefined) return updateArgs;
  return {
    ...(updateArgs ?? {}),
    reasoning_effort: reasoningEffort,
  };
}

export function getByokOpenAIReasoningTierOptions(
  modelHandle: string,
  options?: {
    registryHandle?: string;
    contextWindow?: number;
    reasoningCapabilities?: ReasoningCapabilities | null;
  },
): Array<{
  effort: ModelReasoningSelection;
  modelId: string;
}> {
  const registryHandle = options?.registryHandle ?? modelHandle;
  const hasReportedCapabilities = options?.reasoningCapabilities != null;
  const knownOptions = hasReportedCapabilities
    ? getReasoningTierOptionsFromCapabilities(
        registryHandle,
        options.reasoningCapabilities,
      )
    : getReasoningTierOptionsForHandle(registryHandle, options?.contextWindow);
  const efforts =
    hasReportedCapabilities || knownOptions.length > 0
      ? knownOptions.map((option) => option.effort)
      : REASONING_EFFORT_ORDER;
  return [null, ...efforts].map((effort) => ({
    effort,
    modelId: modelHandle,
  }));
}

export function getPreferredReasoningOption<
  T extends { effort: ModelReasoningSelection },
>(options: T[], selectedEffort: unknown): T | undefined {
  return (
    (selectedEffort === null || typeof selectedEffort === "string"
      ? options.find((option) => option.effort === selectedEffort)
      : undefined) ??
    options.find((option) => option.effort === "medium") ??
    options[0]
  );
}

export function getDefaultModelForTier(billingTier?: string | null): string {
  void billingTier;
  return getDefaultModel();
}

export function formatAvailableModels(): string {
  return models.map((m) => `  ${m.id.padEnd(20)} ${m.handle}`).join("\n");
}

export function getModelInfo(modelIdentifier: string) {
  const direct = resolveCatalogModel(modelIdentifier);
  if (direct) return direct;

  const normalizedHandle = normalizeModelHandleForRegistry(modelIdentifier);
  return normalizedHandle ? resolveCatalogModel(normalizedHandle) : null;
}

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
  const direct = getModelInfo(registryHandle);

  let candidates = models.filter((m) => m.handle === registryHandle);
  if (candidates.length === 0) {
    return direct;
  }

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

  if (llmConfig?.enable_reasoner === false) {
    const match = candidates.find(
      (m) =>
        (m.updateArgs as { enable_reasoner?: unknown } | undefined)
          ?.enable_reasoner === false,
    );
    if (match) return match;
  }

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

export const LEGACY_SERVER_CONTEXT_WINDOW_CLAMP = 128000;

export function preservableContextWindow(
  current: number | null | undefined,
  modelHandle: string,
): number | undefined {
  if (typeof current !== "number" || current <= 0) return undefined;
  if (current !== LEGACY_SERVER_CONTEXT_WINDOW_CLAMP) return current;
  const registryHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  const matchesPreset = models.some(
    (m) =>
      m.handle === registryHandle &&
      (m.updateArgs as { context_window?: number } | null)?.context_window ===
        LEGACY_SERVER_CONTEXT_WINDOW_CLAMP,
  );
  return matchesPreset ? current : undefined;
}

type ModelSelectionContextWindowInput = {
  currentModelHandle?: string | null;
  currentModelId?: string | null;
  currentLlmConfig?: ModelConfigSnapshot | null;
  selectedModelHandle: string;
  selectedContextWindow?: number;
};

export function contextWindowToPreserveForModelSelection(
  input: ModelSelectionContextWindowInput,
): number | undefined {
  return isSameVariantModelSelection(input)
    ? preservableContextWindow(
        input.currentLlmConfig?.context_window,
        input.selectedModelHandle,
      )
    : undefined;
}

function isSameVariantModelSelection(
  input: ModelSelectionContextWindowInput,
): boolean {
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

const RESUME_REFRESH_FIELDS = ["parallel_tool_calls"] as const;

export function getResumeRefreshArgs(
  presetUpdateArgs: Record<string, unknown>,
  agent: {
    llm_config?: { max_tokens?: number | null } | null;
    model_settings?: { parallel_tool_calls?: boolean } | null;
  },
): { updateArgs: Record<string, unknown>; needsUpdate: boolean } {
  const updateArgs: Record<string, unknown> = {};

  for (const field of RESUME_REFRESH_FIELDS) {
    const value = presetUpdateArgs[field];
    if (typeof value === "boolean") {
      updateArgs[field] = value;
    }
  }

  if (Object.keys(updateArgs).length === 0) {
    return { updateArgs, needsUpdate: false };
  }

  const currentParallel = agent.model_settings?.parallel_tool_calls;
  const wantParallel = updateArgs.parallel_tool_calls as boolean | undefined;
  const parallelMatch =
    wantParallel === undefined || currentParallel === wantParallel;

  return { updateArgs, needsUpdate: !parallelMatch };
}

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

  const exactMatch = models.find((m) => m.handle === registryHandle);
  if (exactMatch) return exactMatch;

  const [provider, ...rest] = registryHandle.split("/");
  if (provider && rest.length > 0) {
    const modelPortion = rest.join("/");
    const providerMatches = models.filter((m) => {
      if (!m.handle.startsWith(`${provider}/`)) return false;
      const mModelPortion = m.handle.slice(provider.length + 1);
      return (
        mModelPortion.includes(modelPortion) ||
        modelPortion.includes(mModelPortion)
      );
    });
    const providerMatch = pickPreferred(providerMatches);
    if (providerMatch) return providerMatch;

    const suffixMatches = models.filter((m) =>
      m.handle.endsWith(`/${modelPortion}`),
    );
    const suffixMatch = pickPreferred(suffixMatches);
    if (suffixMatch) return suffixMatch;
  }

  return null;
}

export function getModelDisplayName(handle: string): string | null {
  const model = findModelByHandle(handle);
  return model?.label ?? null;
}

export function getModelShortName(handle: string): string | null {
  const model = findModelByHandle(handle);
  if (!model) return null;
  return (model as { shortLabel?: string }).shortLabel ?? model.label;
}

export function resolveModelByLlmConfig(llmConfigModel: string): string | null {
  const match = models.find((m) => m.handle.endsWith(`/${llmConfigModel}`));
  if (match) return match.id;

  const exactMatch = models.find((m) => {
    const parts = m.handle.split("/");
    return parts.slice(1).join("/") === llmConfigModel;
  });
  if (exactMatch) return exactMatch.id;

  return null;
}
