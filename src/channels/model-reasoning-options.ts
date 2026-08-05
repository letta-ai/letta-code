import {
  getByokOpenAIReasoningTierOptions,
  getReasoningTierOptionsForHandle,
  resolveReasoningTierLookupHandle,
} from "@/agent/model";
import type {
  ListModelsResponseModelEntry,
  UpdateModelPayload,
} from "@/types/protocol_v2";
import { OPENAI_COMPATIBLE_PROXY_UPDATE_ARG } from "@/utils/openai-endpoint";
import type {
  ChannelModelPickerData,
  ChannelReasoningSelection,
} from "./model-picker-types";

export function buildChannelReasoningOptions(
  modelHandle: string,
  entries: ListModelsResponseModelEntry[],
  contextWindow?: number,
  providerType?: string | null,
): NonNullable<ChannelModelPickerData["reasoningOptions"]> {
  const canonicalHandle = resolveReasoningTierLookupHandle(
    modelHandle,
    providerType,
  );
  const proxyEntry = entries.find(
    (entry) =>
      (entry.handle === modelHandle || entry.handle === canonicalHandle) &&
      entry.updateArgs?.[OPENAI_COMPATIBLE_PROXY_UPDATE_ARG] === true,
  );
  if (proxyEntry) {
    return getByokOpenAIReasoningTierOptions(modelHandle, {
      registryHandle: canonicalHandle,
      contextWindow,
      reasoningCapabilities: proxyEntry.reasoningCapabilities,
    });
  }
  return getReasoningTierOptionsForHandle(canonicalHandle, contextWindow);
}

export function buildChannelReasoningUpdatePayload(
  modelHandle: string,
  reasoningEffort: ChannelReasoningSelection,
  options: NonNullable<ChannelModelPickerData["reasoningOptions"]>,
): UpdateModelPayload | null {
  const selected = options.find((option) => option.effort === reasoningEffort);
  return selected
    ? {
        model_id: selected.modelId,
        model_handle: modelHandle,
        reasoning_effort: reasoningEffort,
      }
    : null;
}
