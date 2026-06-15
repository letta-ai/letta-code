import type { Backend } from "@/backend";
import { createModAdapter, type ModAdapter } from "@/mods/mod-adapter";
import type { ModCapabilities, ModContext } from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { getVersion } from "@/version";

export const PROVIDER_ONLY_MOD_CAPABILITIES: ModCapabilities = {
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

export interface CreateProviderOnlyModAdapterOptions {
  cacheDirectory?: string;
  diagnosticsRootDirectory?: string;
  disabled?: boolean;
  getBackend?: () => Backend | undefined;
  globalModsDirectory?: string;
  sessionId?: string | null;
  workingDirectory?: string | null;
}

async function getUnavailableProviderOnlyClient(): Promise<never> {
  throw new Error("letta.client is not available in provider-only mods");
}

export function createProviderOnlyModContext(
  options: Pick<
    CreateProviderOnlyModAdapterOptions,
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

export function createProviderOnlyModAdapter(
  options: CreateProviderOnlyModAdapterOptions = {},
): ModAdapter {
  return createModAdapter({
    ...(options.cacheDirectory
      ? { cacheDirectory: options.cacheDirectory }
      : {}),
    capabilities: PROVIDER_ONLY_MOD_CAPABILITIES,
    ...(options.diagnosticsRootDirectory
      ? { diagnosticsRootDirectory: options.diagnosticsRootDirectory }
      : {}),
    disabled: options.disabled,
    getBackend: options.getBackend,
    getClient: getUnavailableProviderOnlyClient,
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
    initialContext: createProviderOnlyModContext(options),
  });
}

let processProviderOnlyModAdapter: ModAdapter | null = null;
let processProviderOnlyModReload: Promise<void> | null = null;

export async function ensureProviderOnlyModsLoadedForProcess(
  options: CreateProviderOnlyModAdapterOptions = {},
): Promise<void> {
  processProviderOnlyModAdapter ??= createProviderOnlyModAdapter(options);
  processProviderOnlyModAdapter.updateContext(
    createProviderOnlyModContext(options),
  );
  processProviderOnlyModReload ??= processProviderOnlyModAdapter
    .reload()
    .finally(() => {
      processProviderOnlyModReload = null;
    });
  await processProviderOnlyModReload;
}

export function disposeProviderOnlyModsForProcess(): void {
  processProviderOnlyModAdapter?.dispose();
  processProviderOnlyModAdapter = null;
  processProviderOnlyModReload = null;
}
