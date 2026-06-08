import type Letta from "@letta-ai/letta-client";
import { getBackend } from "@/backend";
import {
  createExtensionAdapter,
  type ExtensionAdapter,
} from "@/extensions/extension-adapter";
import type {
  ExtensionCapabilities,
  ExtensionContext,
} from "@/extensions/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { getVersion } from "@/version";
import type { ListenerRuntime } from "./types";

export const LISTENER_EXTENSION_CAPABILITIES: ExtensionCapabilities = {
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

export interface CreateListenerExtensionAdapterOptions {
  cacheDirectory?: string;
  diagnosticsRootDirectory?: string;
  disabled?: boolean;
  globalExtensionsDirectory?: string;
  sessionId?: string | null;
  workingDirectory?: string | null;
}

async function getUnavailableListenerClient(): Promise<Letta> {
  throw new Error(
    "letta.client is not available in listener provider extensions",
  );
}

export function createListenerExtensionContext(
  options: Pick<
    CreateListenerExtensionAdapterOptions,
    "sessionId" | "workingDirectory"
  > = {},
): ExtensionContext {
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

export function createListenerExtensionAdapter(
  options: CreateListenerExtensionAdapterOptions = {},
): ExtensionAdapter {
  return createExtensionAdapter({
    ...(options.cacheDirectory
      ? { cacheDirectory: options.cacheDirectory }
      : {}),
    capabilities: LISTENER_EXTENSION_CAPABILITIES,
    ...(options.diagnosticsRootDirectory
      ? { diagnosticsRootDirectory: options.diagnosticsRootDirectory }
      : {}),
    disabled: options.disabled,
    getBackend,
    getClient: getUnavailableListenerClient,
    ...(options.globalExtensionsDirectory
      ? { globalExtensionsDirectory: options.globalExtensionsDirectory }
      : {}),
    initialContext: createListenerExtensionContext(options),
  });
}

export function ensureListenerExtensionAdapter(
  runtime: ListenerRuntime,
): ExtensionAdapter {
  runtime.extensionAdapter ??= createListenerExtensionAdapter({
    sessionId: runtime.sessionId,
    workingDirectory: runtime.bootWorkingDirectory,
  });
  return runtime.extensionAdapter;
}

export async function reloadListenerExtensionAdapter(
  runtime: ListenerRuntime,
): Promise<void> {
  const adapter = ensureListenerExtensionAdapter(runtime);
  adapter.updateContext(
    createListenerExtensionContext({
      sessionId: runtime.sessionId,
      workingDirectory: runtime.bootWorkingDirectory,
    }),
  );
  await adapter.reload();
}

export function disposeListenerExtensionAdapter(
  runtime: ListenerRuntime,
): void {
  runtime.extensionAdapter?.dispose();
  runtime.extensionAdapter = undefined;
}
