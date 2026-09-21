import type { ModelReasoningEffort } from "@/agent/model";
import { updateConversationLLMConfig } from "@/agent/modify";
import type { Backend } from "@/backend";
import { settingsManager } from "@/settings-manager";
import type { SubagentConfig } from ".";
import {
  type ForkModelOverride,
  getPrimaryAgentModelHandle,
  resolveForkModelOverride,
} from "./subagent-model";

export async function inheritForkToolset(
  agentId: string,
  parentConversationId: string,
  forkConversationId: string,
): Promise<void> {
  const parentToolset = settingsManager.getToolsetPreference(
    agentId,
    parentConversationId,
  );
  if (parentToolset === "auto") return;

  settingsManager.setToolsetPreference(
    agentId,
    parentToolset,
    forkConversationId,
  );
  await settingsManager.flush();
}

interface ForkParentConversationParams {
  backend: Backend;
  parentAgentId: string;
  parentConversationId: string;
  config: SubagentConfig;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  signal?: AbortSignal;
}

interface ForkParentConversationDependencies {
  resolveModelOverride?: () => Promise<ForkModelOverride | null>;
  updateConversationModel?: (
    conversationId: string,
    modelHandle: string,
    updateArgs?: Record<string, unknown>,
  ) => Promise<unknown>;
  inheritToolset?: typeof inheritForkToolset;
}

/** Fork the parent conversation, then apply fork-only runtime configuration. */
export async function forkParentConversation(
  params: ForkParentConversationParams,
  dependencies: ForkParentConversationDependencies = {},
) {
  // Resolve and validate before creating the hidden conversation. Invalid
  // model IDs should not leave an orphan fork behind.
  const modelOverride = await (
    dependencies.resolveModelOverride ??
    (async () => {
      const parent = await getPrimaryAgentModelHandle({
        agentId: params.parentAgentId,
        conversationId: params.parentConversationId,
      });
      return resolveForkModelOverride({
        userModel: params.model,
        recommendedModel: params.config.recommendedModel,
        recommendedModelSource: params.config.recommendedModelSource,
        parentModelHandle: parent.handle,
        reasoningEffort: params.reasoningEffort,
      });
    })
  )();

  const forkedConversation = await params.backend.forkConversation(
    params.parentConversationId,
    {
      ...(params.parentConversationId === "default"
        ? { agentId: params.parentAgentId }
        : {}),
      hidden: true,
      signal: params.signal,
    },
  );

  try {
    if (modelOverride) {
      const updateConversationModel =
        dependencies.updateConversationModel ?? updateConversationLLMConfig;
      await updateConversationModel(
        forkedConversation.id,
        modelOverride.modelHandle,
        modelOverride.updateArgs,
      );
    }
    await (dependencies.inheritToolset ?? inheritForkToolset)(
      params.parentAgentId,
      params.parentConversationId,
      forkedConversation.id,
    );
  } catch (error) {
    await params.backend
      .deleteConversation?.(forkedConversation.id)
      .catch(() => undefined);
    throw error;
  }

  return forkedConversation;
}
