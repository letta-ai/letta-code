import { getModelInfo } from "@/agent/model";
import { getSubagentLifecycleContext } from "@/agent/subagent-state";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { getVersion } from "@/version";
import type { ModContext, ModModelContext } from "./types";

interface AgentContextSource {
  id?: string | null;
  name?: string | null;
  model?: string | null;
  llm_config?: {
    model?: string | null;
    model_endpoint_type?: string | null;
    reasoning_effort?: string | null;
  } | null;
}

function buildModelHandleFromLlmConfig(
  llmConfig: AgentContextSource["llm_config"] | null | undefined,
): string | null {
  if (!llmConfig) return null;
  if (llmConfig.model_endpoint_type && llmConfig.model) {
    return `${llmConfig.model_endpoint_type}/${llmConfig.model}`;
  }
  return llmConfig.model ?? null;
}

function resolveModelContext(options: {
  agent?: AgentContextSource | null;
  base?: ModContext | null;
  modelIdentifier?: string | null;
}): ModModelContext {
  const modelHandle =
    options.modelIdentifier ??
    options.agent?.model ??
    buildModelHandleFromLlmConfig(options.agent?.llm_config) ??
    options.base?.model.id ??
    null;
  const modelInfo = modelHandle ? getModelInfo(modelHandle) : null;
  const provider =
    modelInfo?.handle.split("/")[0] ?? modelHandle?.split("/")[0] ?? null;
  return {
    id: modelHandle,
    displayName: modelInfo?.label ?? modelHandle,
    provider,
    reasoningEffort:
      typeof options.agent?.llm_config?.reasoning_effort === "string"
        ? options.agent.llm_config.reasoning_effort
        : (options.base?.model.reasoningEffort ?? null),
  };
}

export function buildModInvocationContext(
  options: {
    agent?: AgentContextSource | null;
    base?: ModContext | null;
    conversationId?: string | null;
    modelIdentifier?: string | null;
    permissionMode?: string | null;
    toolset?: string | null;
    workingDirectory?: string | null;
  } = {},
): ModContext {
  const base = options.base ?? null;
  const cwd =
    options.workingDirectory ??
    base?.workspace.cwd ??
    getCurrentWorkingDirectory();
  const workspace = {
    cwd,
    currentDir: options.workingDirectory ?? base?.workspace.currentDir ?? cwd,
    projectDir: options.workingDirectory ?? base?.workspace.projectDir ?? cwd,
  };

  return {
    app: base?.app ?? { version: getVersion() },
    workspace,
    cwd,
    sessionId: options.conversationId ?? base?.sessionId ?? null,
    conversationSummary: base?.conversationSummary ?? null,
    lastRunId: base?.lastRunId ?? null,
    agent: {
      id: options.agent?.id ?? base?.agent.id ?? null,
      name: options.agent?.name ?? base?.agent.name ?? null,
    },
    model: resolveModelContext(options),
    toolset: options.toolset ?? base?.toolset ?? null,
    systemPromptId: base?.systemPromptId ?? null,
    permissionMode: options.permissionMode ?? base?.permissionMode ?? null,
    networkPhase: base?.networkPhase ?? null,
    terminalWidth: base?.terminalWidth ?? process.stdout.columns ?? null,
    contextWindow: base?.contextWindow ?? {
      size: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
      remainingPercentage: null,
      currentUsage: null,
    },
    cost: base?.cost ?? {
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: base?.reflection ?? {
      mode: null,
      stepCount: 0,
    },
    memfs: base?.memfs ?? {
      enabled: false,
      memoryDir: null,
    },
    backgroundAgents: base?.backgroundAgents ?? [],
    subagents: base?.subagents ?? getSubagentLifecycleContext(),
  };
}
