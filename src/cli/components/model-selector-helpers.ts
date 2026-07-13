import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  getLocalModelLabel,
  getModelInfo,
  isLocalModelHandle,
  models,
  normalizeModelHandleForRegistry,
} from "@/agent/model";
import {
  getPiProviderSpec,
  isPiProvider,
} from "@/backend/dev/pi-provider-registry";
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";

const CHATGPT_OAUTH_BASE_PROVIDER = "openai-codex";
const CHATGPT_LABEL_SUFFIX_PATTERN = /\s+\(ChatGPT\)$/;
const API_GATED_MODEL_HANDLES = new Set([
  "letta/auto",
  "letta/auto-fast",
  "letta/glm",
]);

function isBuiltInProviderName(
  providerName: string,
  baseProvider: string,
): boolean {
  return (
    providerName === baseProvider ||
    (isPiProvider(baseProvider) &&
      getPiProviderSpec(baseProvider).localProviderNames.includes(providerName))
  );
}

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

export function withProviderMetadataForSelector(
  updateArgs: Record<string, unknown> | undefined,
  providerType: string | undefined,
  isByok: boolean,
  isOpenAICompatibleProxy = false,
): Record<string, unknown> | undefined {
  if (!providerType && !isByok && !isOpenAICompatibleProxy) return updateArgs;
  return {
    ...(updateArgs ?? {}),
    ...(providerType ? { provider_type: providerType } : {}),
    ...(isByok ? { provider_category: "byok" } : {}),
    ...(isOpenAICompatibleProxy
      ? { [OPENAI_COMPATIBLE_PROXY_UPDATE_ARG]: true }
      : {}),
  };
}

export function labelForChatGPTByokAlias(
  label: string,
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return label;

  const providerAlias = handle.slice(0, slashIndex);
  if (
    byokProviderAliases[providerAlias] !== CHATGPT_OAUTH_BASE_PROVIDER ||
    isBuiltInProviderName(providerAlias, CHATGPT_OAUTH_BASE_PROVIDER)
  ) {
    return label;
  }

  return CHATGPT_LABEL_SUFFIX_PATTERN.test(label)
    ? label.replace(CHATGPT_LABEL_SUFFIX_PATTERN, ` (${providerAlias})`)
    : `${label} (${providerAlias})`;
}

export function labelForByokProviderAlias(
  label: string,
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return label;

  const providerAlias = handle.slice(0, slashIndex);
  const baseProvider = byokProviderAliases[providerAlias];
  if (!baseProvider || isBuiltInProviderName(providerAlias, baseProvider)) {
    return label;
  }
  if (baseProvider === CHATGPT_OAUTH_BASE_PROVIDER) {
    return labelForChatGPTByokAlias(label, handle, byokProviderAliases);
  }
  return `${label} (${providerAlias})`;
}

export function withByokProviderAliasLabel<T extends { label: string }>(
  model: T,
  handle: string,
  byokProviderAliases: Record<string, string>,
): T {
  return {
    ...model,
    label: labelForByokProviderAlias(model.label, handle, byokProviderAliases),
  };
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

  if (providerType === "chatgpt_oauth" || providerType === "openai") {
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

export function registryHandleForBackendModelOrAlias(
  handle: string,
  providerType: string | undefined,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  const providerAlias = slashIndex > 0 ? handle.slice(0, slashIndex) : null;
  return providerAlias && byokProviderAliases[providerAlias]
    ? registryHandleForByokAlias(handle, byokProviderAliases)
    : registryHandleForBackendModel(handle, providerType);
}

export function buildModelsForBackendHandle(input: {
  handle: string;
  includeUnknown: boolean;
  providerType?: string;
  byokProviderAliases: Record<string, string>;
  pickPreferredStaticModel: (handle: string) => UiModel | undefined;
  withActualHandle: (
    model: UiModel,
    handle: string,
    registryHandle?: string,
    updateArgs?: Record<string, unknown>,
  ) => UiModel;
  withProviderTypeMetadata: (
    handle: string,
    updateArgs: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | undefined;
}): UiModel[] {
  const registryHandle = registryHandleForBackendModelOrAlias(
    input.handle,
    input.providerType,
    input.byokProviderAliases,
  );
  const baseStaticModel = input.pickPreferredStaticModel(registryHandle);
  const fastRegistryHandle = getChatGptFastRegistryHandleForModelHandle(
    input.handle,
  );
  const baseUpdateArgs = {
    ...((baseStaticModel?.updateArgs as Record<string, unknown> | undefined) ??
      {}),
    ...(fastRegistryHandle ? { service_tier: null } : {}),
  };
  const baseUpdateArgsWithProviderType = input.withProviderTypeMetadata(
    input.handle,
    Object.keys(baseUpdateArgs).length > 0 ? baseUpdateArgs : undefined,
  );
  const fallbackModel = input.includeUnknown
    ? toSelectorModelForHandle(input.handle)
    : null;
  const baseModel = baseStaticModel
    ? input.withActualHandle(
        withByokProviderAliasLabel(
          {
            ...baseStaticModel,
            label: labelForBackendModel(
              baseStaticModel.label,
              input.providerType,
            ),
          },
          input.handle,
          input.byokProviderAliases,
        ),
        input.handle,
        registryHandle,
        baseUpdateArgsWithProviderType,
      )
    : fallbackModel
      ? {
          ...withByokProviderAliasLabel(
            fallbackModel,
            input.handle,
            input.byokProviderAliases,
          ),
          updateArgs: input.withProviderTypeMetadata(
            input.handle,
            fallbackModel.updateArgs,
          ),
        }
      : null;
  const result = baseModel ? [baseModel] : [];

  if (fastRegistryHandle) {
    const fastStaticModel = input.pickPreferredStaticModel(fastRegistryHandle);
    if (fastStaticModel) {
      result.push(
        input.withActualHandle(
          withByokProviderAliasLabel(
            fastStaticModel,
            input.handle,
            input.byokProviderAliases,
          ),
          input.handle,
          fastRegistryHandle,
          {
            ...((fastStaticModel.updateArgs as
              | Record<string, unknown>
              | undefined) ?? {}),
            service_tier: CHATGPT_FAST_SERVICE_TIER,
            ...input.withProviderTypeMetadata(input.handle, undefined),
          },
        ),
      );
    }
  }

  return result;
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
    label: labelForByokProviderAlias(
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
