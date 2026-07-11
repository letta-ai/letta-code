import { getSubagentLifecycleContext } from "@/agent/subagent-state";
import type { ModContext } from "@/cli/mods/types";
import { getVersion } from "@/version";

export interface CliModContextBuildInput {
  modelId?: string | null;
  modelDisplayName?: string | null;
  modelProvider?: string | null;
  reasoningEffort?: string | null;
  systemPromptId?: string | null;
  toolset?: string | null;
  currentDirectory: string;
  projectDirectory: string;
  sessionId?: string | null;
  conversationSummary?: string | null;
  agentId?: string | null;
  agentName?: string | null;
  lastRunId?: string | null;
  totalDurationMs?: number;
  totalApiDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  usedContextTokens?: number;
  reflectionMode?: ModContext["reflection"]["mode"];
  reflectionStepCount?: number;
  memfsEnabled?: boolean;
  memfsDirectory?: string | null;
  permissionMode?: string | null;
  networkPhase?: ModContext["networkPhase"];
  terminalWidth?: number | null;
  backgroundAgents?: ModContext["backgroundAgents"];
}

export function calculateContextPercentages(
  usedTokens: number,
  contextWindowSize: number,
): { used: number; remaining: number } {
  if (contextWindowSize <= 0) {
    return { used: 0, remaining: 100 };
  }

  const used = Math.max(
    0,
    Math.min(100, Math.round((usedTokens / contextWindowSize) * 100)),
  );
  return { used, remaining: Math.max(0, 100 - used) };
}

export function buildCliModContext(input: CliModContextBuildInput): ModContext {
  const totalDurationMs = Math.max(0, Math.floor(input.totalDurationMs ?? 0));
  const totalApiDurationMs = Math.max(
    0,
    Math.floor(input.totalApiDurationMs ?? 0),
  );
  const totalInputTokens = Math.max(0, Math.floor(input.totalInputTokens ?? 0));
  const totalOutputTokens = Math.max(
    0,
    Math.floor(input.totalOutputTokens ?? 0),
  );
  const contextWindowSize = Math.max(
    0,
    Math.floor(input.contextWindowSize ?? 0),
  );
  const usedContextTokens = Math.max(
    0,
    Math.floor(input.usedContextTokens ?? 0),
  );
  const reflectionStepCount = Math.max(
    0,
    Math.floor(input.reflectionStepCount ?? 0),
  );

  const percentages =
    contextWindowSize > 0
      ? calculateContextPercentages(usedContextTokens, contextWindowSize)
      : null;

  return {
    app: { version: getVersion() },
    workspace: {
      cwd: input.currentDirectory,
      currentDir: input.currentDirectory,
      projectDir: input.projectDirectory,
    },
    cwd: input.currentDirectory,
    sessionId: input.sessionId ?? null,
    conversationSummary: input.conversationSummary ?? null,
    lastRunId: input.lastRunId ?? null,
    agent: {
      id: input.agentId ?? null,
      name: input.agentName ?? null,
    },
    model: {
      id: input.modelId ?? null,
      displayName: input.modelDisplayName ?? null,
      provider: input.modelProvider ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
    },
    toolset: input.toolset ?? null,
    systemPromptId: input.systemPromptId ?? null,
    permissionMode: input.permissionMode ?? null,
    networkPhase: input.networkPhase ?? null,
    terminalWidth: input.terminalWidth ?? null,
    contextWindow: {
      size: contextWindowSize,
      totalInputTokens,
      totalOutputTokens,
      usedPercentage: percentages?.used ?? null,
      remainingPercentage: percentages?.remaining ?? null,
      currentUsage: null,
    },
    cost: {
      totalDurationMs,
      totalApiDurationMs,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: {
      mode: input.reflectionMode ?? null,
      stepCount: reflectionStepCount,
    },
    memfs: {
      enabled: input.memfsEnabled ?? false,
      memoryDir: input.memfsDirectory ?? null,
    },
    backgroundAgents: input.backgroundAgents ?? [],
    subagents: getSubagentLifecycleContext(),
  };
}
