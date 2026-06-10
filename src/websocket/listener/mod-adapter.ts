import type Letta from "@letta-ai/letta-client";
import { getBackend } from "@/backend";
import { createModAdapter, type ModAdapter } from "@/mods/mod-adapter";
import type { ModCapabilities, ModContext } from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { getVersion } from "@/version";
import type { ListenerRuntime } from "./types";

export const LISTENER_MOD_CAPABILITIES: ModCapabilities = {
  tools: false,
  commands: false,
  events: {
    lifecycle: false,
    tools: false,
    turns: false,
  },
  permissions: false,
  providers: true,
  ui: {
    panels: false,
    statusValues: false,
    customStatuslineRenderer: false,
  },
};

export interface CreateListenerModAdapterOptions {
  cacheDirectory?: string;
  diagnosticsRootDirectory?: string;
  disabled?: boolean;
  globalModsDirectory?: string;
  sessionId?: string | null;
  workingDirectory?: string | null;
}

async function getUnavailableListenerClient(): Promise<Letta> {
  throw new Error("letta.client is not available in listener provider mods");
}

export function createListenerModContext(
  options: Pick<
    CreateListenerModAdapterOptions,
    "sessionId" | "workingDirectory"
  > = {},
): ModContext {
  const cwd = options.workingDirectory ?? getCurrentWorkingDirectory();
  return {
    app: { version: getVersion() },
    workspace: {
      cwd,
      currentDir: cwd,
      projectDir: cwd,
    },
    cwd,
    sessionId: options.sessionId ?? null,
    lastRunId: null,
    agent: {
      id: null,
      name: null,
    },
    model: {
      id: null,
      displayName: null,
      provider: null,
      reasoningEffort: null,
    },
    toolset: null,
    systemPromptId: null,
    permissionMode: null,
    networkPhase: null,
    terminalWidth: process.stdout.columns ?? null,
    contextWindow: {
      size: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      usedPercentage: null,
      remainingPercentage: null,
      currentUsage: null,
    },
    cost: {
      totalDurationMs: 0,
      totalApiDurationMs: 0,
      totalCostUsd: null,
      totalLinesAdded: null,
      totalLinesRemoved: null,
    },
    reflection: {
      mode: null,
      stepCount: 0,
    },
    memfs: {
      enabled: false,
      memoryDir: null,
    },
    backgroundAgents: [],
  };
}

export function createListenerModAdapter(
  options: CreateListenerModAdapterOptions = {},
): ModAdapter {
  return createModAdapter({
    ...(options.cacheDirectory
      ? { cacheDirectory: options.cacheDirectory }
      : {}),
    capabilities: LISTENER_MOD_CAPABILITIES,
    ...(options.diagnosticsRootDirectory
      ? { diagnosticsRootDirectory: options.diagnosticsRootDirectory }
      : {}),
    disabled: options.disabled,
    getBackend,
    getClient: getUnavailableListenerClient,
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
    initialContext: createListenerModContext(options),
  });
}

export function ensureListenerModAdapter(runtime: ListenerRuntime): ModAdapter {
  runtime.modAdapter ??= createListenerModAdapter({
    sessionId: runtime.sessionId,
    workingDirectory: runtime.bootWorkingDirectory,
  });
  return runtime.modAdapter;
}

export async function reloadListenerModAdapter(
  runtime: ListenerRuntime,
): Promise<void> {
  const adapter = ensureListenerModAdapter(runtime);
  adapter.updateContext(
    createListenerModContext({
      sessionId: runtime.sessionId,
      workingDirectory: runtime.bootWorkingDirectory,
    }),
  );
  await adapter.reload();
}

export function disposeListenerModAdapter(runtime: ListenerRuntime): void {
  runtime.modAdapter?.dispose();
  runtime.modAdapter = undefined;
}
