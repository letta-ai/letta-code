import type { LlmConfig } from "@letta-ai/letta-client/resources/models/models";
import {
  getModelInfoForLlmConfig,
  preservableContextWindow,
} from "@/agent/model";
import { normalizeKnownModelHandle } from "@/agent/model-handles";

type CarryoverLlmConfig = LlmConfig & {
  enable_reasoner?: boolean | null;
  service_tier?: string | null;
};

export function normalizeConversationModelCarryoverHandle(
  rawModelHandle: string,
): string {
  return normalizeKnownModelHandle(rawModelHandle);
}

export function buildConversationModelCarryoverUpdate(params: {
  rawModelHandle: string | null;
  currentLlmConfig: LlmConfig | null;
  activeConversationContextWindowLimit?: number | null;
}): {
  modelHandle: string;
  updateArgs?: Record<string, unknown>;
  /**
   * The active conversation's preserved context window, when one exists and
   * is not server-clamp poison. Callers must pass this through
   * `contextWindowOverride` so it survives on local backends too (local
   * catalog resolution ignores updateArgs.context_window). Catalog preset
   * windows stay in updateArgs only — local backends own those limits.
   */
  contextWindowOverride?: number;
} | null {
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

  // Carry the active conversation's window forward — unless it looks like
  // the server's legacy 128k clamp (LET-9786), in which case fall back to the
  // model preset so new conversations start healed rather than poisoned.
  // The preserved value rides as contextWindowOverride (honored on all
  // backends); the preset stays in updateArgs (local backends deliberately
  // ignore it in favor of the pi catalog).
  const contextWindowOverride = preservableContextWindow(
    activeConversationContextWindowLimit,
    modelHandle,
  );
  if (contextWindowOverride !== undefined) {
    updateArgs.context_window = contextWindowOverride;
  }

  return {
    modelHandle,
    updateArgs: Object.keys(updateArgs).length > 0 ? updateArgs : undefined,
    ...(contextWindowOverride !== undefined ? { contextWindowOverride } : {}),
  };
}
