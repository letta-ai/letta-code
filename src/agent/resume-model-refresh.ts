import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  getModelPresetUpdateForAgent,
  getModelUpdateArgs,
  getResumeRefreshArgs,
  type ModelReasoningEffort,
  preservableContextWindow,
  resolveModel,
  withReasoningEffortUpdateArg,
} from "@/agent/model";
import { updateAgentLLMConfig } from "@/agent/modify";

/** Invalid CLI input, as opposed to a failed update request. */
export class ResumeModelOverrideError extends Error {}

/**
 * Apply a resuming agent's optional model and reasoning-effort overrides,
 * falling back to refreshing the agent's catalog preset when neither was
 * requested. Throws on invalid input; CLI callers surface the message and exit.
 */
export async function applyResumeModelOverrides(params: {
  agent: AgentState;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
}): Promise<AgentState> {
  const { agent, model, reasoningEffort } = params;

  if (model) {
    const modelHandle = resolveModel(model);
    if (typeof modelHandle !== "string") {
      throw new ResumeModelOverrideError(`Invalid model "${model}"`);
    }

    // Always apply the model update - different model IDs can share a handle
    // but carry different settings (e.g. gpt-5.2-medium vs gpt-5.2-xhigh).
    const updateArgs = withReasoningEffortUpdateArg(
      getModelUpdateArgs(model),
      reasoningEffort,
    );
    return await updateAgentLLMConfig(agent.id, modelHandle, updateArgs);
  }

  if (reasoningEffort) {
    // Changing only the effort on an already-configured agent is the `letta
    // model set --reasoning` path, which resolves the agent's current model
    // itself. Fail loudly rather than silently dropping the flag.
    throw new ResumeModelOverrideError(
      "--reasoning-effort requires --model when resuming an existing agent. Use `letta model set --reasoning <level>` to change an existing agent's reasoning effort.",
    );
  }

  const presetRefresh = getModelPresetUpdateForAgent(agent);
  if (!presetRefresh) return agent;

  const { updateArgs, needsUpdate } = getResumeRefreshArgs(
    presetRefresh.updateArgs,
    agent,
  );
  if (!needsUpdate) return agent;

  // Resume refresh must not reset the context window; preserve it by
  // re-sending the agent's current value explicitly (omitting it makes the
  // server re-derive + clamp to a legacy 128k default - LET-9786). A current
  // value that looks like that clamp is not preserved, letting the agent heal.
  const preservedContextWindow = preservableContextWindow(
    agent.llm_config?.context_window,
    presetRefresh.modelHandle,
  );
  return await updateAgentLLMConfig(
    agent.id,
    presetRefresh.modelHandle,
    updateArgs,
    preservedContextWindow !== undefined
      ? { contextWindowOverride: preservedContextWindow }
      : undefined,
  );
}
