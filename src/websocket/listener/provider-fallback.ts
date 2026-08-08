import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getModelInfo, getModelInfoForLlmConfig } from "@/agent/model";
import { PROVIDER_FALLBACK_MAP } from "./constants";

export type ProviderFallbackState = {
  sourceModelId: string | null;
  attempted: boolean;
  overrideModel?: string;
};

export function createProviderFallbackState(
  agent: AgentState | null | undefined,
  overrideModel?: string,
): ProviderFallbackState {
  const llmConfig = agent?.llm_config;
  const model = llmConfig?.model;
  if (!model) {
    return { sourceModelId: null, attempted: false, overrideModel };
  }

  const modelInfo =
    getModelInfoForLlmConfig(model, llmConfig) ?? getModelInfo(model);

  return {
    sourceModelId: modelInfo?.id ?? model,
    attempted: false,
    overrideModel,
  };
}

/**
 * Resolve the override_model to attach to one request of a listener turn.
 *
 * A turn spans multiple HTTP requests (one per client-side tool round-trip)
 * and the server re-resolves the effective model on every request, so an
 * agent/conversation PATCH landing mid-turn would otherwise switch the model
 * between tool calls while tool schemas stay pinned to the turn-start
 * toolset. Pinning the turn-start snapshot closes that gap.
 *
 * Precedence: provider fallback (reliability action) beats a live /model
 * switch (deliberate user action), which beats the turn-start snapshot. The
 * snapshot itself is the resolved conversation-override → agent-fallback
 * value, so conversation-level model overrides win inherently.
 */
export function resolveTurnRequestOverrideModel(params: {
  providerFallbackOverride?: string | null;
  liveModelSwitchHandle?: string | null;
  turnStartEffectiveModel?: string | null;
}): string | undefined {
  return (
    params.providerFallbackOverride ??
    params.liveModelSwitchHandle ??
    params.turnStartEffectiveModel ??
    undefined
  );
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
