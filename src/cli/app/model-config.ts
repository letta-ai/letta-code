import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import { getModelInfo, type ModelReasoningEffort } from "@/agent/model";
import {
  mapModelHandleToLlmConfigPatch,
  resolveModelHandleFromLlmConfig,
} from "@/agent/model-handles";
import { ERROR_FEEDBACK_HINT, PROVIDER_STATUS_PAGES } from "./constants";

/**
 * Derives the current reasoning effort from agent state (canonical) with llm_config as fallback.
 * model_settings is the source of truth; llm_config.reasoning_effort is a legacy field.
 */
export function deriveReasoningEffort(
  modelSettings: AgentState["model_settings"] | undefined | null,
  llmConfig: LlmConfig | null | undefined,
): ModelReasoningEffort | null {
  if (modelSettings && "provider_type" in modelSettings) {
    const providerType = modelSettings.provider_type as string | undefined;
    // OpenAI/OpenRouter: reasoning.reasoning_effort
    if (
      (providerType === "openai" ||
        providerType === "openai-codex" ||
        providerType === "chatgpt_oauth") &&
      "reasoning" in modelSettings &&
      modelSettings.reasoning
    ) {
      const re = (modelSettings.reasoning as { reasoning_effort?: string })
        .reasoning_effort;
      if (
        re === "none" ||
        re === "minimal" ||
        re === "low" ||
        re === "medium" ||
        re === "high" ||
        re === "xhigh" ||
        re === "max"
      )
        return re;
    }

    // Moonshot: top-level reasoning_effort field
    if (providerType === "moonshot" || providerType === "moonshotai") {
      const effort = (modelSettings as { reasoning_effort?: string | null })
        .reasoning_effort;
      if (
        effort === "none" ||
        effort === "minimal" ||
        effort === "low" ||
        effort === "medium" ||
        effort === "high" ||
        effort === "xhigh" ||
        effort === "max"
      ) {
        return effort;
      }
    }

    // Anthropic/Bedrock: effort field
    if (providerType === "anthropic" || providerType === "bedrock") {
      const effort = (modelSettings as { effort?: string | null }).effort;
      if (effort === "low" || effort === "medium" || effort === "high")
        return effort;
      if (effort === "xhigh" || effort === "max")
        return effort as ModelReasoningEffort;
    }
  }
  // Fallback: deprecated llm_config fields
  const re = llmConfig?.reasoning_effort as string | null | undefined;
  if (
    re === "none" ||
    re === "minimal" ||
    re === "low" ||
    re === "medium" ||
    re === "high" ||
    re === "xhigh" ||
    re === "max"
  )
    return re as ModelReasoningEffort;
  if (
    (llmConfig as { enable_reasoner?: boolean | null })?.enable_reasoner ===
    false
  )
    return "none";
  return null;
}

export function inferReasoningEffortFromModelPreset(
  modelId: string | null | undefined,
  modelHandle: string | null | undefined,
): ModelReasoningEffort | null {
  const modelInfo =
    (modelId ? getModelInfo(modelId) : null) ??
    (modelHandle ? getModelInfo(modelHandle) : null);
  const presetEffort = (
    modelInfo?.updateArgs as { reasoning_effort?: unknown } | undefined
  )?.reasoning_effort;

  if (
    presetEffort === "none" ||
    presetEffort === "minimal" ||
    presetEffort === "low" ||
    presetEffort === "medium" ||
    presetEffort === "high" ||
    presetEffort === "xhigh" ||
    presetEffort === "max"
  ) {
    return presetEffort;
  }

  return null;
}

export function buildModelHandleFromLlmConfig(
  llmConfig: LlmConfig | null | undefined,
): string | null {
  return resolveModelHandleFromLlmConfig(llmConfig);
}

export function getPreferredAgentModelHandle(
  agent: Pick<AgentState, "model" | "llm_config"> | null | undefined,
): string | null {
  if (!agent) return null;
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  return buildModelHandleFromLlmConfig(agent.llm_config);
}

export function providerTypeFromModelSettings(
  modelSettings: unknown,
): string | null {
  if (
    typeof modelSettings !== "object" ||
    modelSettings === null ||
    !("provider_type" in modelSettings)
  ) {
    return null;
  }
  const providerType = (modelSettings as { provider_type?: unknown })
    .provider_type;
  return typeof providerType === "string" && providerType.length > 0
    ? providerType
    : null;
}

export function providerTypeFromUpdateArgs(
  updateArgs: Record<string, unknown> | undefined | null,
): string | null {
  const providerType = updateArgs?.provider_type;
  return typeof providerType === "string" && providerType.length > 0
    ? providerType
    : null;
}

export function mapHandleToLlmConfigPatch(
  modelHandle: string,
  providerType?: string | null,
): Partial<LlmConfig> {
  return mapModelHandleToLlmConfigPatch(
    modelHandle,
    providerType,
  ) as Partial<LlmConfig>;
}

// Helper to get appropriate error hint based on stop reason and current model
export function getErrorHintForStopReason(
  stopReason: StopReasonType | null,
  currentModelId: string | null,
  modelEndpointType?: string | null,
): string {
  if (stopReason !== "llm_api_error") {
    return ERROR_FEEDBACK_HINT;
  }

  // When the user is on an auto-routed model (letta/auto*), the reported
  // model_endpoint_type reflects whichever downstream provider the proxy chose,
  // not a provider the user explicitly selected. Don't blame a specific
  // provider in that case -- the issue may be on the proxy side.
  const isAutoModel = currentModelId?.startsWith("auto") ?? false;
  const statusInfo =
    modelEndpointType && !isAutoModel
      ? PROVIDER_STATUS_PAGES[modelEndpointType]
      : undefined;

  // Build the /model swap suggestion -- mention Bedrock Opus if applicable.
  const bedrockOpusSuggestion =
    modelEndpointType === "anthropic" &&
    currentModelId?.startsWith("opus-4.7") &&
    getModelInfo("bedrock-opus-4.7")
      ? "Opus 4.7 via Amazon Bedrock"
      : modelEndpointType === "anthropic" &&
          currentModelId?.startsWith("opus-4.6") &&
          getModelInfo("bedrock-opus-4.6")
        ? "Opus 4.6 via Amazon Bedrock"
        : null;
  const modelSwapSuffix = bedrockOpusSuggestion
    ? ` (e.g. ${bedrockOpusSuggestion})`
    : "";

  if (statusInfo) {
    return [
      `Downstream provider (${statusInfo.name}) is experiencing errors — check ${statusInfo.url} for additional information`,
      `(note that the official status page may not be reliable / up-to-date).`,
      `Use /model to swap to a model from a different provider${modelSwapSuffix}, or try again later.`,
    ].join(" ");
  }

  return `Downstream provider is experiencing errors. Use /model to swap to a model from a different provider, or try again later.`;
}
