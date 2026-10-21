import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  getModelPresetUpdateForAgent,
  getModelUpdateArgs,
  getResumeRefreshArgs,
  preservableContextWindow,
} from "@/agent/model";
import { buildModelSettings, updateAgentLLMConfig } from "@/agent/modify";
import type { ConversationCreateBody } from "@/backend";

export async function prepareExistingHeadlessModel(options: {
  agent: AgentState;
  modelIdentifier?: string;
  modelHandle?: string;
  createsConversation: boolean;
  localModelCatalog: boolean;
}): Promise<{
  agent: AgentState;
  conversationModel?: Partial<ConversationCreateBody>;
}> {
  const {
    agent,
    modelIdentifier,
    modelHandle,
    createsConversation,
    localModelCatalog,
  } = options;

  if (modelHandle) {
    const updateArgs = getModelUpdateArgs(modelIdentifier);
    if (createsConversation) {
      const contextWindow = updateArgs?.context_window;
      return {
        agent,
        conversationModel: {
          model: modelHandle,
          model_settings: buildModelSettings(
            modelHandle,
            updateArgs,
            localModelCatalog,
          ),
          ...(typeof contextWindow === "number" && {
            context_window_limit: contextWindow,
          }),
        },
      };
    }

    return {
      agent: await updateAgentLLMConfig(agent.id, modelHandle, updateArgs),
    };
  }

  const presetRefresh = getModelPresetUpdateForAgent(agent);
  if (!presetRefresh) return { agent };

  const { updateArgs, needsUpdate } = getResumeRefreshArgs(
    presetRefresh.updateArgs,
    agent,
  );
  if (!needsUpdate) return { agent };

  // A current value that looks like the server's legacy 128k clamp is not
  // preserved, so the preset can heal it on resume (LET-9786).
  const preservedContextWindow = preservableContextWindow(
    agent.llm_config?.context_window,
    presetRefresh.modelHandle,
  );
  return {
    agent: await updateAgentLLMConfig(
      agent.id,
      presetRefresh.modelHandle,
      updateArgs,
      preservedContextWindow !== undefined
        ? { contextWindowOverride: preservedContextWindow }
        : undefined,
    ),
  };
}
