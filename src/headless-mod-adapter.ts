import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getModelInfo } from "@/agent/model";
import type { SessionStats } from "@/agent/stats";
import type { Backend } from "@/backend";
import { getClient } from "@/backend/api/client";
import type { ReflectionSettings } from "@/cli/helpers/memory-reminder";
import { createModAdapter, type ModAdapter } from "@/mods/mod-adapter";
import type {
  ModCapabilities,
  ModContext,
  ModConversationOpenReason,
} from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { telemetry } from "@/telemetry";
import { getVersion } from "@/version";

export const HEADLESS_MOD_CAPABILITIES: ModCapabilities = {
  tools: true,
  commands: false,
  events: {
    lifecycle: true,
    tools: true,
    turns: true,
    compact: true,
    llm: true,
  },
  permissions: true,
  providers: true,
  ui: {
    panels: false,
  },
};

function isHeadlessMemfsEnabled(agentId: string): boolean {
  try {
    return settingsManager.isMemfsEnabled(agentId);
  } catch {
    return false;
  }
}

export function createHeadlessModContext(options: {
  agent: AgentState;
  conversationId: string;
  lastRunId?: string | null;
  permissionMode?: string | null;
  reflectionSettings?: ReflectionSettings;
  sessionStats?: SessionStats | null;
}): ModContext {
  const cwd = getCurrentWorkingDirectory();
  const modelId = options.agent.llm_config?.model ?? null;
  const modelInfo = modelId ? getModelInfo(modelId) : null;
  const stats = options.sessionStats?.getSnapshot();
  const contextWindowSize =
    typeof options.agent.llm_config?.context_window === "number"
      ? options.agent.llm_config.context_window
      : 0;
  const contextTokens = stats?.usage.contextTokens ?? null;
  const usedPercentage =
    contextWindowSize > 0 && typeof contextTokens === "number"
      ? Math.max(
          0,
          Math.min(100, Math.round((contextTokens / contextWindowSize) * 100)),
        )
      : null;
  const memfsEnabled = isHeadlessMemfsEnabled(options.agent.id);

  return {
    app: { version: getVersion() },
    workspace: {
      cwd,
      currentDir: cwd,
      projectDir: cwd,
    },
    cwd,
    sessionId: options.conversationId,
    lastRunId: options.lastRunId ?? null,
    agent: {
      id: options.agent.id,
      name: options.agent.name ?? null,
    },
    model: {
      id: modelId,
      displayName: modelInfo?.label ?? modelId,
      provider: modelInfo?.handle.split("/")[0] ?? null,
      reasoningEffort:
        typeof options.agent.llm_config?.reasoning_effort === "string"
          ? options.agent.llm_config.reasoning_effort
          : null,
    },
    toolset: null,
    systemPromptId: null,
    permissionMode: options.permissionMode ?? null,
    networkPhase: null,
    terminalWidth: process.stdout.columns ?? null,
    contextWindow: {
      size: contextWindowSize,
      totalInputTokens: stats?.usage.promptTokens ?? 0,
      totalOutputTokens: stats?.usage.completionTokens ?? 0,
      usedPercentage,
      remainingPercentage:
        usedPercentage === null ? null : Math.max(0, 100 - usedPercentage),
      currentUsage: null,
    },
    cost: {
      totalDurationMs: stats?.totalWallMs ?? 0,
      totalApiDurationMs: stats?.totalApiMs ?? 0,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: {
      mode: options.reflectionSettings?.trigger ?? null,
      stepCount: options.reflectionSettings?.stepCount ?? 0,
    },
    memfs: {
      enabled: memfsEnabled,
      memoryDir: memfsEnabled
        ? getScopedMemoryFilesystemRoot(options.agent.id)
        : null,
    },
    backgroundAgents: [],
  };
}

export function createHeadlessModAdapter(options: {
  agent: AgentState;
  backend: Backend;
  cacheDirectory?: string;
  conversationId: string;
  disabled?: boolean;
  globalModsDirectory?: string;
  permissionMode?: string | null;
  reflectionSettings?: ReflectionSettings;
  sessionStats?: SessionStats | null;
}): ModAdapter {
  const agentModsDirectory = isHeadlessMemfsEnabled(options.agent.id)
    ? join(getScopedMemoryFilesystemRoot(options.agent.id), "mods")
    : undefined;

  return createModAdapter({
    ...(agentModsDirectory ? { agentModsDirectory } : {}),
    ...(options.cacheDirectory
      ? { cacheDirectory: options.cacheDirectory }
      : {}),
    capabilities: HEADLESS_MOD_CAPABILITIES,
    disabled: options.disabled,
    getBackend: () => options.backend,
    getClient,
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
  });
}

export async function emitHeadlessConversationOpen(options: {
  agent: AgentState;
  conversationId: string;
  reason: ModConversationOpenReason;
  adapter: ModAdapter;
  context?: ModContext;
}): Promise<void> {
  await options.adapter.events.emit(
    "conversation_open",
    {
      agentId: options.agent.id,
      agentName: options.agent.name ?? null,
      conversationId: options.conversationId,
      reason: options.reason,
    },
    options.context ?? createHeadlessModContext(options),
  );
}

export async function emitHeadlessConversationClose(options: {
  agent: AgentState;
  conversationId: string;
  durationMs: number | null;
  adapter: ModAdapter;
  context?: ModContext;
}): Promise<void> {
  await options.adapter.events.emit(
    "conversation_close",
    {
      agentId: options.agent.id,
      conversationId: options.conversationId,
      durationMs: options.durationMs,
      messageCount: telemetry.getMessageCount(),
      reason: "quit",
      toolCallCount: telemetry.getToolCallCount(),
    },
    options.context ?? createHeadlessModContext(options),
  );
}
