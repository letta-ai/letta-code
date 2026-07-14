import {
  getLocalModelLabel,
  getModelInfo,
  isLocalModelHandle,
  models,
  normalizeModelHandleForRegistry,
} from "@/agent/model";

const CHATGPT_OAUTH_BASE_PROVIDER = "openai-codex";
const CHATGPT_LABEL_SUFFIX_PATTERN = /\s+\(ChatGPT\)$/;
const XAI_SUPERGROK_LABEL_SUFFIX_PATTERN = /\s+\(SuperGrok\)$/;
const XAI_API_KEY_LABEL_SUFFIX_PATTERN = /\s+\(API key\)$/;
const API_GATED_MODEL_HANDLES = new Set([
  "letta/auto",
  "letta/auto-fast",
  "letta/glm",
]);

export type ProviderAuthType = "api" | "oauth";

/** Local provider name / handle prefix → how that provider is authenticated. */
export type ProviderAuthByName = ReadonlyMap<string, ProviderAuthType>;

export type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  registryHandle?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
};

export type ModelSelectorSelection = Pick<
  UiModel,
  "id" | "handle" | "label" | "description" | "registryHandle" | "updateArgs"
>;

export function labelForChatGPTByokAlias(
  label: string,
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return label;

  const providerAlias = handle.slice(0, slashIndex);
  if (byokProviderAliases[providerAlias] !== CHATGPT_OAUTH_BASE_PROVIDER) {
    return label;
  }

  return label.replace(CHATGPT_LABEL_SUFFIX_PATTERN, ` (${providerAlias})`);
}

export function baseHandleForByokAlias(
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return handle;

  const provider = handle.slice(0, slashIndex);
  const model = handle.slice(slashIndex + 1);
  const baseProvider = byokProviderAliases[provider];

  return baseProvider ? `${baseProvider}/${model}` : handle;
}

export function registryHandleForByokAlias(
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const baseHandle = baseHandleForByokAlias(handle, byokProviderAliases);
  return normalizeModelHandleForRegistry(baseHandle) ?? baseHandle;
}

export function registryHandleForBackendModel(
  handle: string,
  providerType?: string,
): string {
  const normalizedHandle = normalizeModelHandleForRegistry(handle) ?? handle;
  if (models.some((model) => model.handle === normalizedHandle)) {
    return normalizedHandle;
  }

  if (providerType === "chatgpt_oauth") {
    const slashIndex = handle.indexOf("/");
    if (slashIndex > 0) {
      const directHandle = `openai/${handle.slice(slashIndex + 1)}`;
      if (models.some((model) => model.handle === directHandle)) {
        return directHandle;
      }
    }
  }

  return normalizedHandle;
}

export function labelForBackendModel(
  label: string,
  providerType?: string,
): string {
  if (
    providerType !== "chatgpt_oauth" ||
    CHATGPT_LABEL_SUFFIX_PATTERN.test(label)
  ) {
    return label;
  }
  return `${label} (ChatGPT)`;
}

export function providerNameFromModelHandle(
  handle: string,
): string | undefined {
  const slashIndex = handle.indexOf("/");
  if (slashIndex <= 0) return undefined;
  return handle.slice(0, slashIndex);
}

/**
 * Mark local dual-auth providers (xAI SuperGrok OAuth vs API key) so /model
 * does not look like an anonymous "xAI API" catalog when only OAuth is linked.
 */
export function applyProviderAuthPresentation(
  model: UiModel,
  authByProvider: ProviderAuthByName | undefined,
): UiModel {
  if (!authByProvider || authByProvider.size === 0) return model;

  const providerName = providerNameFromModelHandle(model.handle);
  if (!providerName) return model;

  // xAI SuperGrok OAuth and console API key share provider_type=xai / handle prefix xai/
  if (providerName === "xai") {
    const authType = authByProvider.get("xai");
    if (authType === "oauth") {
      const label = XAI_SUPERGROK_LABEL_SUFFIX_PATTERN.test(model.label)
        ? model.label
        : `${model.label.replace(XAI_API_KEY_LABEL_SUFFIX_PATTERN, "")} (SuperGrok)`;
      return {
        ...model,
        label,
        description: "SuperGrok / X Premium+ subscription (OAuth — no API key)",
      };
    }
    if (authType === "api") {
      const label = XAI_API_KEY_LABEL_SUFFIX_PATTERN.test(model.label)
        ? model.label
        : `${model.label.replace(XAI_SUPERGROK_LABEL_SUFFIX_PATTERN, "")} (API key)`;
      return {
        ...model,
        label,
        description: "xAI console API key",
      };
    }
  }

  return model;
}

export function toByokSelectorModel(
  staticModel: UiModel,
  handle: string,
  byokProviderAliases: Record<string, string>,
  updateArgs?: Record<string, unknown>,
): UiModel {
  const resolvedUpdateArgs =
    updateArgs ??
    (staticModel.updateArgs as Record<string, unknown> | undefined);

  return {
    ...staticModel,
    id: handle,
    handle,
    registryHandle: registryHandleForByokAlias(handle, byokProviderAliases),
    label: labelForChatGPTByokAlias(
      staticModel.label,
      handle,
      byokProviderAliases,
    ),
    updateArgs: resolvedUpdateArgs,
  };
}

export function toSelectorModelForHandle(handle: string): UiModel {
  const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
  const modelInfo = getModelInfo(registryHandle);
  if (modelInfo) {
    return {
      id: handle,
      handle,
      registryHandle,
      label: modelInfo.label,
      description: modelInfo.description ?? "",
      updateArgs: modelInfo.updateArgs as Record<string, unknown> | undefined,
    };
  }
  return {
    id: handle,
    handle,
    label: getLocalModelLabel(handle),
    description: "",
  };
}

export function includeUnknownBackendHandleInRecommended(
  handle: string,
): boolean {
  const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
  return isLocalModelHandle(registryHandle);
}

export function filterModelsByAvailabilityForSelector<
  T extends { handle: string },
>(
  typedModels: T[],
  availableHandles: Set<string> | null,
  allApiHandles: string[],
): T[] {
  if (availableHandles === null) {
    return typedModels.filter((model) => {
      if (!API_GATED_MODEL_HANDLES.has(model.handle)) return true;
      return allApiHandles.includes(model.handle);
    });
  }

  return typedModels.filter((model) => availableHandles.has(model.handle));
}
