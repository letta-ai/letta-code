import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { isRecord } from "@/utils/type-guards";
import { getModelCatalogEntry } from "./available-models";
import { normalizeModelHandleForRegistry } from "./model";
import { updateAgentLLMConfig } from "./modify";

function contextWindowFromAgent(agent: AgentState): number | undefined {
  const agentRecord = agent as unknown as Record<string, unknown>;
  if (typeof agentRecord.context_window_limit === "number") {
    return agentRecord.context_window_limit;
  }
  return typeof agent.llm_config?.context_window === "number"
    ? agent.llm_config.context_window
    : undefined;
}

function maxTokensFromAgent(agent: AgentState): number | null | undefined {
  const agentRecord = agent as unknown as Record<string, unknown>;
  if (
    typeof agentRecord.max_tokens === "number" ||
    agentRecord.max_tokens === null
  ) {
    return agentRecord.max_tokens;
  }
  if (
    typeof agent.llm_config?.max_tokens === "number" ||
    agent.llm_config?.max_tokens === null
  ) {
    return agent.llm_config.max_tokens;
  }
  const modelSettings = agent.model_settings;
  if (!isRecord(modelSettings)) return undefined;
  if (
    typeof modelSettings.max_tokens === "number" ||
    modelSettings.max_tokens === null
  ) {
    return modelSettings.max_tokens;
  }
  return typeof modelSettings.max_output_tokens === "number"
    ? modelSettings.max_output_tokens
    : undefined;
}

function temperatureFromAgent(agent: AgentState): number | undefined {
  return isRecord(agent.model_settings) &&
    typeof agent.model_settings.temperature === "number"
    ? agent.model_settings.temperature
    : undefined;
}

function modelHandleFromAgent(agent: AgentState): string | null {
  if (typeof agent.model === "string" && agent.model.length > 0) {
    return agent.model;
  }
  const llmConfig = agent.llm_config;
  if (!llmConfig || typeof llmConfig.model !== "string") return null;
  return typeof llmConfig.model_endpoint_type === "string"
    ? `${llmConfig.model_endpoint_type}/${llmConfig.model}`
    : llmConfig.model;
}

function positiveUpdateArg(
  updateArgs: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = updateArgs?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function clampExistingLimit(params: {
  field: "context_window_limit" | "max_tokens";
  current: number;
  ceiling?: number;
  destinationChanged: boolean;
  warnings: string[];
}): number {
  const { field, current, ceiling, destinationChanged, warnings } = params;
  if (typeof ceiling === "number" && current > ceiling) {
    warnings.push(
      `Clamped preserved ${field} from ${current} to ${ceiling} for the selected model.`,
    );
    return ceiling;
  }
  if (ceiling === undefined && destinationChanged) {
    warnings.push(
      `The selected model did not report a ${field} limit; preserving the existing value ${current} for backend validation.`,
    );
  }
  return current;
}

async function modelCatalogEntryForUpdate(
  modelHandle: string,
  warnings: string[],
) {
  try {
    return await getModelCatalogEntry(modelHandle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warnings.push(
      `Could not load backend limits for ${modelHandle} (${message}); using preset limits and backend validation.`,
    );
    return undefined;
  }
}

export interface ExistingAgentLLMConfigUpdateResult {
  agent: AgentState;
  warnings: string[];
}

/**
 * Change an existing agent's model while using its persisted generation
 * configuration as the baseline.
 *
 * Model identity, provider settings, and reasoning controls come from the
 * selected model preset. Context/output caps and temperature come from the
 * existing agent, with numeric caps clamped to backend-reported model limits.
 * This is intentionally separate from fresh-agent creation and interactive
 * /model, both of which retain their preset-default behavior.
 */
export async function updateExistingAgentLLMConfig(
  currentAgent: AgentState,
  modelHandle: string,
  updateArgs?: Record<string, unknown>,
): Promise<ExistingAgentLLMConfigUpdateResult> {
  const currentHandle = modelHandleFromAgent(currentAgent);
  const normalizedCurrentHandle = currentHandle
    ? (normalizeModelHandleForRegistry(currentHandle) ?? currentHandle)
    : null;
  const normalizedSelectedHandle =
    normalizeModelHandleForRegistry(modelHandle) ?? modelHandle;
  const destinationChanged =
    normalizedCurrentHandle !== null &&
    normalizedCurrentHandle !== normalizedSelectedHandle;
  const warnings: string[] = [];
  const catalogEntry = await modelCatalogEntryForUpdate(modelHandle, warnings);

  // Prefer the backend's supported maximum. A preset value is a safe fallback
  // when a backend listing omits limits, but it is a creation default rather
  // than the source of truth for an existing agent's configured cap.
  const contextCeiling =
    catalogEntry?.maxContextWindow ??
    positiveUpdateArg(updateArgs, "context_window");
  const maxTokensCeiling =
    catalogEntry?.maxOutputTokens ??
    positiveUpdateArg(updateArgs, "max_output_tokens");
  const currentContextWindow = contextWindowFromAgent(currentAgent);
  const currentMaxTokens = maxTokensFromAgent(currentAgent);
  const contextWindowOverride =
    currentContextWindow === undefined
      ? undefined
      : clampExistingLimit({
          field: "context_window_limit",
          current: currentContextWindow,
          ceiling: contextCeiling,
          destinationChanged,
          warnings,
        });
  const maxTokensOverride =
    typeof currentMaxTokens === "number"
      ? clampExistingLimit({
          field: "max_tokens",
          current: currentMaxTokens,
          ceiling: maxTokensCeiling,
          destinationChanged,
          warnings,
        })
      : currentMaxTokens;
  const temperature = temperatureFromAgent(currentAgent);
  const preservedUpdateArgs = {
    ...(updateArgs ?? {}),
    ...(typeof updateArgs?.provider_type !== "string" &&
    typeof catalogEntry?.providerType === "string"
      ? { provider_type: catalogEntry.providerType }
      : {}),
    ...(maxTokensOverride !== undefined
      ? { max_output_tokens: maxTokensOverride }
      : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };

  const agent = await updateAgentLLMConfig(
    currentAgent.id,
    modelHandle,
    preservedUpdateArgs,
    {
      ...(contextWindowOverride !== undefined ? { contextWindowOverride } : {}),
      ...(maxTokensOverride !== undefined ? { maxTokensOverride } : {}),
    },
  );

  const finalContextWindow = contextWindowFromAgent(agent);
  if (
    contextWindowOverride !== undefined &&
    finalContextWindow !== undefined &&
    finalContextWindow !== contextWindowOverride
  ) {
    warnings.push(
      `The backend adjusted context_window_limit from ${contextWindowOverride} to ${finalContextWindow}.`,
    );
  }
  const finalMaxTokens = maxTokensFromAgent(agent);
  if (
    maxTokensOverride !== undefined &&
    finalMaxTokens !== undefined &&
    finalMaxTokens !== maxTokensOverride
  ) {
    warnings.push(
      `The backend adjusted max_tokens from ${maxTokensOverride} to ${finalMaxTokens}.`,
    );
  }

  return { agent, warnings };
}
