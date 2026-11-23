import { getAvailableModelHandles } from "@/agent/available-models";
import { getCurrentAgentId } from "@/agent/context";
import { getDefaultModelForTier, resolveModel } from "@/agent/model";
import { resolveCatalogModel } from "@/agent/model-catalog";
import { type BackendMode, getBackend } from "@/backend";
import { getBillingTier } from "@/backend/api/metadata";

export function getModelHandleFromAgent(agent: {
  model?: string | null;
  model_settings?: { provider_type?: unknown } | null;
  llm_config?: { model_endpoint_type?: string | null; model?: string | null };
}): string | null {
  const directModel = agent.model;
  if (directModel?.includes("/")) {
    return directModel;
  }
  const settingsProvider = agent.model_settings?.provider_type;
  if (typeof settingsProvider === "string" && directModel) {
    return `${settingsProvider}/${directModel}`;
  }
  const endpoint = agent.llm_config?.model_endpoint_type;
  const model = agent.llm_config?.model;
  if (endpoint && model) {
    return `${endpoint}/${model}`;
  }
  return directModel || model || null;
}

export async function getPrimaryAgentModelHandle(
  scope: { agentId?: string | null; conversationId?: string | null } = {},
): Promise<{
  handle: string | null;
  agent: {
    model?: string | null;
    name?: string | null;
    model_settings?: { provider_type?: unknown } | null;
    llm_config?: { model_endpoint_type?: string | null; model?: string | null };
  } | null;
}> {
  try {
    const agentId = scope.agentId ?? getCurrentAgentId();
    const agent = await getBackend().retrieveAgent(agentId);
    const conversationId = scope.conversationId;
    if (conversationId && conversationId !== "default") {
      try {
        const conversation = await getBackend().retrieveConversation(
          conversationId,
          {
            query: { include_context_message_ids: false },
          },
        );
        const conversationHandle = getModelHandleFromAgent(conversation);
        if (conversationHandle) {
          return { handle: conversationHandle, agent };
        }
      } catch {}
    }
    return { handle: getModelHandleFromAgent(agent), agent };
  } catch {
    return { handle: null, agent: null };
  }
}

export async function getCurrentBillingTier(): Promise<string | null> {
  return getBillingTier();
}

const BYOK_PROVIDER_TO_BASE: Record<string, string> = {
  "lc-anthropic": "anthropic",
  "lc-openai": "openai",
  "lc-zai": "zai",
  "lc-gemini": "google_ai",
  "lc-openrouter": "openrouter",
  "lc-minimax": "minimax",
  "lc-bedrock": "bedrock",
  "chatgpt-plus-pro": "chatgpt-plus-pro",
};

function getProviderPrefix(handle: string): string | null {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return null;
  return handle.slice(0, slashIndex);
}

function swapProviderPrefix(
  parentHandle: string,
  recommendedHandle: string,
): string | null {
  const parentProvider = getProviderPrefix(parentHandle);
  if (!parentProvider) return null;

  const baseProvider = BYOK_PROVIDER_TO_BASE[parentProvider];
  if (!baseProvider) return null;

  const recommendedProvider = getProviderPrefix(recommendedHandle);
  if (!recommendedProvider || recommendedProvider !== baseProvider) return null;

  const modelPortion = recommendedHandle.slice(recommendedProvider.length + 1);
  return `${parentProvider}/${modelPortion}`;
}

function isInheritModel(model: string | null | undefined): boolean {
  return model?.trim().toLowerCase() === "inherit";
}

export interface ForkModelOverride {
  modelHandle: string;
  updateArgs?: Record<string, unknown>;
}

export async function resolveForkModelOverride(options: {
  userModel?: string;
  recommendedModel?: string;
  recommendedModelSource?: "builtin" | "user";
  parentModelHandle?: string | null;
  availableModels?: Awaited<ReturnType<typeof getAvailableModelHandles>>;
}): Promise<ForkModelOverride | null> {
  const requestedModel =
    options.userModel !== undefined
      ? options.userModel
      : options.recommendedModelSource === "user"
        ? options.recommendedModel
        : undefined;
  if (!requestedModel || isInheritModel(requestedModel)) return null;

  const catalogModel = resolveCatalogModel(requestedModel);
  const resolvedHandle = catalogModel?.handle ?? resolveModel(requestedModel);
  if (!resolvedHandle) {
    throw new Error(`Unknown fork model: ${requestedModel}`);
  }

  const available =
    options.availableModels ?? (await getAvailableModelHandles());
  let modelHandle = resolvedHandle;
  const catalogProviderType = catalogModel?.updateArgs?.provider_type;
  let providerType =
    (typeof catalogProviderType === "string" && catalogProviderType) ||
    available.providerTypes.get(resolvedHandle) ||
    getProviderPrefix(resolvedHandle) ||
    undefined;

  if (catalogModel && options.parentModelHandle) {
    const parentProviderType = available.providerTypes.get(
      options.parentModelHandle,
    );
    const parentProvider = getProviderPrefix(options.parentModelHandle);
    const modelPortion = resolvedHandle.slice(resolvedHandle.indexOf("/") + 1);
    if (
      parentProviderType &&
      parentProviderType === providerType &&
      parentProvider
    ) {
      const byokHandle = `${parentProvider}/${modelPortion}`;
      if (available.handles.has(byokHandle)) {
        modelHandle = byokHandle;
        providerType = parentProviderType;
      }
    }
  }

  if (!available.handles.has(modelHandle)) {
    throw new Error(`Fork model is not available: ${requestedModel}`);
  }

  const updateArgs = catalogModel?.updateArgs
    ? {
        ...catalogModel.updateArgs,
        ...(providerType ? { provider_type: providerType } : {}),
      }
    : providerType
      ? { provider_type: providerType }
      : undefined;

  return { modelHandle, ...(updateArgs ? { updateArgs } : {}) };
}

export async function resolveSubagentModel(options: {
  userModel?: string;
  recommendedModel?: string;
  recommendedModelSource?: "builtin" | "user";
  parentModelHandle?: string | null;
  billingTier?: string | null;
  availableHandles?: Set<string>;
  subagentType?: string;
  backendMode?: BackendMode;
}): Promise<string | null> {
  const { userModel, recommendedModel, parentModelHandle, billingTier } =
    options;
  const isFreeTier = billingTier?.toLowerCase() === "free";
  const userRequestedInheritance = isInheritModel(userModel);
  const effectiveRecommendedModel = userRequestedInheritance
    ? "inherit"
    : recommendedModel;

  const recommendedSelection = (handle: string): string => {
    if (!effectiveRecommendedModel) return handle;
    const entry = resolveCatalogModel(effectiveRecommendedModel);
    return entry && entry.handle === handle
      ? effectiveRecommendedModel
      : handle;
  };

  if (userModel && !userRequestedInheritance) return userModel;

  if (
    options.recommendedModelSource === "user" &&
    effectiveRecommendedModel &&
    !isInheritModel(effectiveRecommendedModel)
  ) {
    const recommendedHandle = resolveModel(effectiveRecommendedModel);
    if (recommendedHandle) {
      return recommendedSelection(recommendedHandle);
    }
  }

  if (options.backendMode === "local" && parentModelHandle) {
    return parentModelHandle;
  }

  if (options.subagentType === "reflection") {
    if (
      effectiveRecommendedModel &&
      !isInheritModel(effectiveRecommendedModel)
    ) {
      const recommendedHandle = resolveModel(effectiveRecommendedModel);
      if (recommendedHandle) {
        return recommendedSelection(recommendedHandle);
      }
    }

    return "letta/auto-memory";
  }

  if (isInheritModel(effectiveRecommendedModel) && parentModelHandle) {
    return parentModelHandle;
  }

  let recommendedHandle: string | null = null;
  if (effectiveRecommendedModel && !isInheritModel(effectiveRecommendedModel)) {
    recommendedHandle = resolveModel(effectiveRecommendedModel);
  }

  let availableHandles: Set<string> | null = options.availableHandles ?? null;
  const isAvailable = async (handle: string): Promise<boolean> => {
    try {
      if (!availableHandles) {
        const result = await getAvailableModelHandles();
        availableHandles = result.handles;
      }
      return availableHandles.has(handle);
    } catch {
      return false;
    }
  };

  const freeTierDefaultHandle = isFreeTier ? resolveModel("auto-fast") : null;
  if (freeTierDefaultHandle && (await isAvailable(freeTierDefaultHandle))) {
    return freeTierDefaultHandle;
  }

  if (isFreeTier) {
    const defaultHandle = getDefaultModelForTier(billingTier);
    if (defaultHandle && (await isAvailable(defaultHandle))) {
      return defaultHandle;
    }
  }

  if (parentModelHandle) {
    const parentProvider = getProviderPrefix(parentModelHandle);
    const parentBaseProvider = parentProvider
      ? BYOK_PROVIDER_TO_BASE[parentProvider]
      : null;
    const parentIsByok = !!parentBaseProvider;

    if (recommendedHandle) {
      const recommendedProvider = getProviderPrefix(recommendedHandle);

      if (parentIsByok) {
        if (recommendedProvider === parentProvider) {
          if (await isAvailable(recommendedHandle)) {
            return recommendedSelection(recommendedHandle);
          }
        } else {
          const swapped = swapProviderPrefix(
            parentModelHandle,
            recommendedHandle,
          );
          if (swapped && (await isAvailable(swapped))) {
            return swapped;
          }
        }

        return parentModelHandle;
      }

      if (await isAvailable(recommendedHandle)) {
        return recommendedSelection(recommendedHandle);
      }
    }

    return parentModelHandle;
  }

  if (recommendedHandle && (await isAvailable(recommendedHandle))) {
    return recommendedSelection(recommendedHandle);
  }

  const defaultHandle = getDefaultModelForTier(billingTier);
  if (defaultHandle && (await isAvailable(defaultHandle))) {
    return defaultHandle;
  }

  return recommendedHandle ? recommendedSelection(recommendedHandle) : null;
}
