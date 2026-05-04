import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getBackend } from "../backend";
import { getModelInfo, models } from "./model";

export const MIN_CONTEXT_WINDOW_TOKENS = 30_000;

type ModelConfigSnapshot = {
  model?: string | null;
  model_endpoint_type?: string | null;
  reasoning_effort?: string | null;
  enable_reasoner?: boolean | null;
  context_window?: number | null;
};

export type SetMaxContextArgs = {
  value: number | null;
  override: boolean;
};

export type SetMaxContextResult = {
  contextWindow: number;
  reset: boolean;
  override: boolean;
  appliedTo: "agent" | "conversation";
  defaultContextWindow?: number;
  modelLabel?: string;
  updatedAgent?: AgentState;
};

type ModelContextDefault = {
  contextWindow?: number;
  modelLabel?: string;
};

function buildModelHandleFromConfig(
  config: ModelConfigSnapshot | null | undefined,
): string | null {
  if (!config) return null;
  if (config.model_endpoint_type && config.model) {
    return `${config.model_endpoint_type}/${config.model}`;
  }
  return config.model ?? null;
}

function numericUpdateArg(
  updateArgs: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = updateArgs?.[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function getUpdateArgs(model: (typeof models)[number] | null | undefined) {
  return model?.updateArgs && typeof model.updateArgs === "object"
    ? (model.updateArgs as Record<string, unknown>)
    : undefined;
}

export function formatContextWindowTokens(value: number): string {
  return value.toLocaleString("en-US");
}

export function parseContextWindowValue(raw: string): number | null {
  const trimmed = raw.trim().replace(/_/g, "").replace(/,/g, "");
  const match = trimmed.match(/^(\d+)([kKmM]?)$/);
  if (!match) return null;
  const base = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isSafeInteger(base)) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const value = base * multiplier;
  return Number.isSafeInteger(value) ? value : null;
}

export function parseSetMaxContextArgs(
  args: string | undefined,
): SetMaxContextArgs {
  const tokens = (args ?? "").trim().split(/\s+/).filter(Boolean);
  let override = false;
  const values: string[] = [];

  for (const token of tokens) {
    if (token === "--override") {
      override = true;
    } else if (token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    } else {
      values.push(token);
    }
  }

  if (values.length > 1) {
    throw new Error("Usage: /set-max-context [tokens] [--override]");
  }

  if (values.length === 0) {
    return { value: null, override };
  }

  const value = parseContextWindowValue(values[0] ?? "");
  if (value === null || value <= 0) {
    throw new Error(
      `Invalid context window "${values[0]}". Provide a positive token count, e.g. 200000 or 200k.`,
    );
  }

  return { value, override };
}

export function resolveModelJsonContextWindow(input: {
  modelId?: string | null;
  modelHandle?: string | null;
  llmConfig?: ModelConfigSnapshot | null;
  currentContextWindow?: number | null;
}): ModelContextDefault {
  const byId = input.modelId ? getModelInfo(input.modelId) : null;
  const byIdContextWindow = numericUpdateArg(
    getUpdateArgs(byId),
    "context_window",
  );
  if (byIdContextWindow !== undefined) {
    return { contextWindow: byIdContextWindow, modelLabel: byId?.label };
  }

  const modelHandle =
    input.modelHandle ?? buildModelHandleFromConfig(input.llmConfig);
  if (!modelHandle) return {};

  let candidates = models.filter((model) => model.handle === modelHandle);
  if (candidates.length === 0) return {};

  const currentContextWindow = input.currentContextWindow;
  if (typeof currentContextWindow === "number") {
    const exactContextWindowMatch = candidates.find(
      (model) =>
        numericUpdateArg(getUpdateArgs(model), "context_window") ===
        currentContextWindow,
    );
    if (exactContextWindowMatch) {
      return {
        contextWindow: currentContextWindow,
        modelLabel: exactContextWindowMatch.label,
      };
    }
  }

  const effort = input.llmConfig?.reasoning_effort;
  if (effort) {
    const effortMatches = candidates.filter(
      (model) => getUpdateArgs(model)?.reasoning_effort === effort,
    );
    if (effortMatches.length > 0) {
      candidates = effortMatches;
    }
  }

  const enableReasoner = input.llmConfig?.enable_reasoner;
  if (typeof enableReasoner === "boolean") {
    const reasonerMatches = candidates.filter(
      (model) => getUpdateArgs(model)?.enable_reasoner === enableReasoner,
    );
    if (reasonerMatches.length > 0) {
      candidates = reasonerMatches;
    }
  }

  const candidatesWithContext = candidates
    .map((model) => ({
      model,
      contextWindow: numericUpdateArg(getUpdateArgs(model), "context_window"),
    }))
    .filter(
      (
        entry,
      ): entry is { model: (typeof models)[number]; contextWindow: number } =>
        entry.contextWindow !== undefined,
    );

  if (candidatesWithContext.length === 0) return {};

  const selected =
    typeof currentContextWindow === "number"
      ? (candidatesWithContext
          .filter((entry) => entry.contextWindow >= currentContextWindow)
          .sort((a, b) => a.contextWindow - b.contextWindow)[0] ??
        candidatesWithContext.sort(
          (a, b) => b.contextWindow - a.contextWindow,
        )[0])
      : candidatesWithContext[0];

  return {
    contextWindow: selected?.contextWindow,
    modelLabel: selected?.model.label,
  };
}

function validateRequestedContextWindow(params: {
  value: number;
  defaultContextWindow?: number;
  override: boolean;
}): void {
  const { value, defaultContextWindow, override } = params;
  if (!override && value < MIN_CONTEXT_WINDOW_TOKENS) {
    throw new Error(
      `Context window must be at least ${formatContextWindowTokens(MIN_CONTEXT_WINDOW_TOKENS)} tokens. Use --override to apply a smaller value.`,
    );
  }

  if (
    !override &&
    defaultContextWindow !== undefined &&
    value > defaultContextWindow
  ) {
    throw new Error(
      `Context window cannot exceed the model.json default of ${formatContextWindowTokens(defaultContextWindow)} tokens. Use --override to apply a larger value.`,
    );
  }
}

export async function applySetMaxContext(params: {
  agentId: string;
  conversationId: string;
  args?: string;
  currentModelId?: string | null;
  currentModelHandle?: string | null;
  currentLlmConfig?: ModelConfigSnapshot | null;
  currentContextWindow?: number | null;
}): Promise<SetMaxContextResult> {
  const parsed = parseSetMaxContextArgs(params.args);
  const backend = getBackend();
  const agent = await backend.retrieveAgent(params.agentId);
  const isDefaultConversation = params.conversationId === "default";
  const conversation = isDefaultConversation
    ? null
    : await backend.retrieveConversation(params.conversationId);

  const conversationRecord = (conversation ?? {}) as Record<string, unknown>;
  const agentRecord = agent as unknown as Record<string, unknown>;
  const conversationContextWindow =
    typeof conversationRecord.context_window_limit === "number"
      ? conversationRecord.context_window_limit
      : undefined;
  const agentContextWindow =
    typeof agentRecord.context_window_limit === "number"
      ? agentRecord.context_window_limit
      : undefined;
  const effectiveContextWindow =
    params.currentContextWindow ??
    conversationContextWindow ??
    agentContextWindow ??
    null;
  const effectiveModelHandle =
    params.currentModelHandle ??
    (typeof conversationRecord.model === "string"
      ? conversationRecord.model
      : null) ??
    (typeof agent.model === "string" && agent.model.length > 0
      ? agent.model
      : null) ??
    buildModelHandleFromConfig(agent.llm_config as ModelConfigSnapshot | null);
  const effectiveLlmConfig =
    params.currentLlmConfig ??
    ((agent.llm_config ?? null) as ModelConfigSnapshot | null);
  const modelDefault = resolveModelJsonContextWindow({
    modelId: params.currentModelId,
    modelHandle: effectiveModelHandle,
    llmConfig: effectiveLlmConfig,
    currentContextWindow: effectiveContextWindow,
  });

  const reset = parsed.value === null;
  const contextWindow = reset ? modelDefault.contextWindow : parsed.value;
  if (contextWindow === undefined || contextWindow === null) {
    throw new Error(
      "No default value for max context window found in model.json",
    );
  }

  if (!reset) {
    validateRequestedContextWindow({
      value: contextWindow,
      defaultContextWindow: modelDefault.contextWindow,
      override: parsed.override,
    });
  }

  if (isDefaultConversation) {
    const updatedAgent = await backend.updateAgent(params.agentId, {
      context_window_limit: contextWindow,
    } as Parameters<typeof backend.updateAgent>[1]);
    return {
      contextWindow,
      reset,
      override: parsed.override,
      appliedTo: "agent",
      defaultContextWindow: modelDefault.contextWindow,
      modelLabel: modelDefault.modelLabel,
      updatedAgent,
    };
  }

  await backend.updateConversation(params.conversationId, {
    context_window_limit: contextWindow,
  } as Parameters<typeof backend.updateConversation>[1]);
  return {
    contextWindow,
    reset,
    override: parsed.override,
    appliedTo: "conversation",
    defaultContextWindow: modelDefault.contextWindow,
    modelLabel: modelDefault.modelLabel,
  };
}

export function formatSetMaxContextResult(result: SetMaxContextResult): string {
  const target =
    result.appliedTo === "agent" ? "Agent" : "Current conversation";
  const value = formatContextWindowTokens(result.contextWindow);
  const modelSuffix = result.modelLabel ? ` for ${result.modelLabel}` : "";
  if (result.reset) {
    return `${target} max context reset to ${value} tokens${modelSuffix}.`;
  }
  return `${target} max context set to ${value} tokens${
    result.override ? " with override" : ""
  }.`;
}
