import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  getModelInfoForLlmConfig,
  normalizeModelHandleForRegistry,
} from "@/agent/model";
import { OPENAI_CODEX_PROVIDER_NAME } from "@/providers/openai-codex-provider";

type CarryoverLlmConfig = LlmConfig & {
  enable_reasoner?: boolean | null;
  service_tier?: string | null;
};

export function normalizeConversationModelCarryoverHandle(
  rawModelHandle: string,
): string {
  const [provider, ...modelParts] = rawModelHandle.split("/");
  if (provider === "chatgpt_oauth" && modelParts.length > 0) {
    return `${OPENAI_CODEX_PROVIDER_NAME}/${modelParts.join("/")}`;
  }
  return normalizeModelHandleForRegistry(rawModelHandle) ?? rawModelHandle;
}

export function buildConversationModelCarryoverUpdate(params: {
  rawModelHandle: string | null;
  currentLlmConfig: LlmConfig | null;
  activeConversationContextWindowLimit?: number | null;
}): { modelHandle: string; updateArgs?: Record<string, unknown> } | null {
  const { rawModelHandle, currentLlmConfig } = params;
  if (!rawModelHandle) return null;

  const modelHandle = normalizeConversationModelCarryoverHandle(rawModelHandle);
  const carryoverLlmConfig = currentLlmConfig as CarryoverLlmConfig | null;
  const activeConversationContextWindowLimit =
    params.activeConversationContextWindowLimit;
  const modelInfo = getModelInfoForLlmConfig(modelHandle, {
    reasoning_effort: carryoverLlmConfig?.reasoning_effort ?? null,
    enable_reasoner: carryoverLlmConfig?.enable_reasoner ?? null,
    context_window:
      typeof activeConversationContextWindowLimit === "number"
        ? activeConversationContextWindowLimit
        : null,
    service_tier: carryoverLlmConfig?.service_tier ?? null,
  });

  const updateArgs: Record<string, unknown> = {
    ...((modelInfo?.updateArgs as Record<string, unknown> | undefined) ?? {}),
  };
  const reasoningEffort = carryoverLlmConfig?.reasoning_effort;
  if (
    typeof reasoningEffort === "string" &&
    updateArgs.reasoning_effort === undefined
  ) {
    updateArgs.reasoning_effort = reasoningEffort;
  }
  const enableReasoner = carryoverLlmConfig?.enable_reasoner;
  if (
    typeof enableReasoner === "boolean" &&
    updateArgs.enable_reasoner === undefined
  ) {
    updateArgs.enable_reasoner = enableReasoner;
  }

  const modelPresetContextWindow = updateArgs.context_window;
  const contextWindow =
    typeof activeConversationContextWindowLimit === "number"
      ? activeConversationContextWindowLimit
      : typeof modelPresetContextWindow === "number"
        ? modelPresetContextWindow
        : undefined;
  if (typeof contextWindow === "number") {
    updateArgs.context_window = contextWindow;
  }

  return {
    modelHandle,
    updateArgs: Object.keys(updateArgs).length > 0 ? updateArgs : undefined,
  };
}
