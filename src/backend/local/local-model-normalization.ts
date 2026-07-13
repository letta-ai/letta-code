import {
  mapModelHandleToLlmConfigPatch,
  resolveModelHandleFromLlmConfig,
} from "@/agent/model-handles";
import { resolveRegisteredPiProviderFromModelHandle } from "@/backend/dev/pi-provider-mod-registry";
import { isResolvablePiModelHandle } from "@/backend/dev/pi-provider-registry";
import { isRecord } from "@/utils/type-guards";

export function supportedModelSettingsFromBody(
  bodyRecord: Record<string, unknown>,
): Record<string, unknown> {
  const modelSettings = isRecord(bodyRecord.model_settings)
    ? { ...bodyRecord.model_settings }
    : {};

  if (typeof bodyRecord.context_window_limit === "number") {
    modelSettings.context_window_limit = bodyRecord.context_window_limit;
  }
  if (typeof bodyRecord.parallel_tool_calls === "boolean") {
    modelSettings.parallel_tool_calls = bodyRecord.parallel_tool_calls;
  }
  if (
    typeof bodyRecord.max_tokens === "number" ||
    bodyRecord.max_tokens === null
  ) {
    modelSettings.max_tokens = bodyRecord.max_tokens;
  }

  return modelSettings;
}

export function providerTypeFromModelSettings(
  modelSettings: Record<string, unknown> | undefined,
): string | null {
  const providerType = modelSettings?.provider_type;
  return typeof providerType === "string" && providerType.length > 0
    ? providerType
    : null;
}

export function normalizeLocalModelHandle(
  model: string,
  modelSettings?: Record<string, unknown>,
  legacyLlmConfig?: Record<string, unknown>,
): string {
  if (
    isResolvablePiModelHandle(model) ||
    resolveRegisteredPiProviderFromModelHandle(model)
  ) {
    return model;
  }
  const providerType = providerTypeFromModelSettings(modelSettings);
  if (
    model.includes("/") &&
    (providerType === "chatgpt_oauth" || providerType === "anthropic")
  ) {
    // Named local OAuth connections use their storage record as the provider
    // prefix (for example, "personal/gpt-5.6-sol"). They are not Pi catalog
    // prefixes, so normalizing them through legacy endpoint metadata corrupts
    // the handle into "chatgpt-plus-pro/personal/gpt-5.6-sol".
    return model;
  }
  const legacyEndpointType = legacyLlmConfig?.model_endpoint_type;
  return (
    resolveModelHandleFromLlmConfig({
      model,
      model_endpoint_type:
        providerType ??
        (typeof legacyEndpointType === "string" ? legacyEndpointType : null),
    }) ?? model
  );
}

export function modelHandleFromLegacyLlmConfig(
  legacyLlmConfig: Record<string, unknown>,
): string | null {
  const model = legacyLlmConfig.model;
  if (typeof model !== "string") return null;
  const modelEndpointType = legacyLlmConfig.model_endpoint_type;
  return resolveModelHandleFromLlmConfig({
    model,
    model_endpoint_type:
      typeof modelEndpointType === "string" ? modelEndpointType : null,
  });
}

export function supportedConversationModelSettingsFromBody(
  bodyRecord: Record<string, unknown>,
): Record<string, unknown> | null | undefined {
  const rawSettings = bodyRecord.model_settings;
  const modelSettings =
    rawSettings === null
      ? null
      : isRecord(rawSettings)
        ? { ...rawSettings }
        : undefined;
  if (modelSettings === null) return null;

  const next = modelSettings ?? {};
  if (
    typeof bodyRecord.max_tokens === "number" ||
    bodyRecord.max_tokens === null
  ) {
    next.max_tokens = bodyRecord.max_tokens;
  }

  return Object.keys(next).length > 0 ? next : modelSettings;
}

export function normalizeStoredLocalModelRecord<
  T extends { model?: string | null; model_settings?: unknown },
>(record: T): T {
  if (typeof record.model !== "string") return record;
  const modelSettings = isRecord(record.model_settings)
    ? record.model_settings
    : {};
  const normalizedModel = normalizeLocalModelHandle(
    record.model,
    modelSettings,
  );
  return normalizedModel === record.model
    ? record
    : { ...record, model: normalizedModel };
}

export function localLlmConfigModelPatch(
  model: string,
  modelSettings: Record<string, unknown>,
) {
  return mapModelHandleToLlmConfigPatch(
    model,
    providerTypeFromModelSettings(modelSettings),
  );
}
