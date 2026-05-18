import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelInfo, getModelInfoForLlmConfig } from "../../agent/model";
import { PROVIDER_FALLBACK_MAP } from "./constants";

export type ProviderFallbackState = {
  sourceModelId: string | null;
  attempted: boolean;
  overrideModel?: string;
};

export function createProviderFallbackState(
  agent: AgentState | null | undefined,
): ProviderFallbackState {
  const llmConfig = agent?.llm_config;
  const model = llmConfig?.model;
  if (!model) {
    return { sourceModelId: null, attempted: false };
  }

  const modelInfo =
    getModelInfoForLlmConfig(model, llmConfig) ?? getModelInfo(model);

  return {
    sourceModelId: modelInfo?.id ?? model,
    attempted: false,
  };
}

export function maybeApplyProviderFallback(
  state: ProviderFallbackState | undefined,
  attempt: number,
): string | null {
  if (!state || state.attempted || attempt < 2 || !state.sourceModelId) {
    return null;
  }

  const fallbackId = PROVIDER_FALLBACK_MAP[state.sourceModelId];
  const fallbackHandle = fallbackId ? getModelInfo(fallbackId)?.handle : null;
  if (!fallbackHandle) {
    return null;
  }

  state.attempted = true;
  state.overrideModel = fallbackHandle;
  return fallbackHandle;
}
