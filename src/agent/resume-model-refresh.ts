import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import {
  getAgentModelHandle,
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

  // Effort without a model applies against the agent's current model, the same
  // thing `letta model set --reasoning` does and the same shape the fork path
  // uses for an effort-only override. Chris's call: the flag stays independent
  // of --model on every path, and like --model on resume it persists onto the
  // agent rather than applying to one run.
  const presetRefresh = getModelPresetUpdateForAgent(agent);
  const effortRequested = reasoningEffort !== undefined;
  const targetHandle = presetRefresh?.modelHandle ?? getAgentModelHandle(agent);

  if (!targetHandle) {
    if (effortRequested) {
      throw new ResumeModelOverrideError(
        `Cannot apply --reasoning-effort: agent ${agent.id} has no model to attach it to. Set one with \`letta model set <handle> --reasoning ${reasoningEffort}\`.`,
      );
    }
    return agent;
  }
  if (!presetRefresh && !effortRequested) return agent;

  // An effort-only request must write even when no preset field is stale: the
  // preset lookup returns null for a model that carries no catalog args, which
  // is exactly the BYOK/proxy case this flag exists for.
  const { updateArgs, needsUpdate } = getResumeRefreshArgs(
    presetRefresh?.updateArgs ?? {},
    agent,
  );
  if (!needsUpdate && !effortRequested) return agent;

  // Resume refresh must not reset the context window; preserve it by
  // re-sending the agent's current value explicitly (omitting it makes the
  // server re-derive + clamp to a legacy 128k default - LET-9786). A current
  // value that looks like that clamp is not preserved, letting the agent heal.
  const preservedContextWindow = preservableContextWindow(
    agent.llm_config?.context_window,
    targetHandle,
  );
  return await updateAgentLLMConfig(
    agent.id,
    targetHandle,
    withReasoningEffortUpdateArg(updateArgs, reasoningEffort),
    preservedContextWindow !== undefined
      ? { contextWindowOverride: preservedContextWindow }
      : undefined,
  );
}
