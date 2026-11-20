import { getModelHandleFromAgent } from "@/agent/subagents/subagent-model";
import { getBackend } from "@/backend";

export interface ParentModelLimits {
  model: string | null;
  modelSettings?: { max_output_tokens: number };
  contextWindowLimit?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function limits(entity: unknown): Omit<ParentModelLimits, "model"> {
  const source = record(entity);
  const legacy = record(source.llm_config);
  const settings = record(source.model_settings);
  const output =
    positiveNumber(settings.max_output_tokens) ??
    positiveNumber(record(legacy.model_settings).max_output_tokens) ??
    positiveNumber(legacy.max_tokens);
  const context =
    positiveNumber(source.context_window_limit) ??
    positiveNumber(settings.context_window_limit) ??
    positiveNumber(legacy.context_window);
  return {
    ...(output !== undefined
      ? { modelSettings: { max_output_tokens: output } }
      : {}),
    ...(context !== undefined ? { contextWindowLimit: context } : {}),
  };
}

/** Read only token budgets; provider settings and child effort stay independent. */
export async function resolveParentModelLimits(
  agentId: string,
  conversationId?: string | null,
): Promise<ParentModelLimits | null> {
  try {
    const backend = getBackend();
    const agent = await backend.retrieveAgent(agentId);
    const model = getModelHandleFromAgent(agent);
    const parent: ParentModelLimits = { model, ...limits(agent) };
    if (!conversationId || conversationId === "default") return parent;
    const conversation = await backend
      .retrieveConversation(conversationId)
      .catch(() => null);
    // Keep model selection's existing fallback, but do not copy agent budgets
    // when an unavailable conversation might override them.
    if (!conversation) return { model };
    const conversationModel = getModelHandleFromAgent(conversation);
    // A conversation pinned to another model must not reuse the agent's budgets.
    return {
      ...(conversationModel && conversationModel !== model ? {} : parent),
      model: conversationModel ?? model,
      ...limits(conversation),
    };
  } catch {
    // Parent lookup is best-effort, like parent model selection. Keep catalog
    // defaults when its settings are unavailable rather than blocking a launch.
    return null;
  }
}
