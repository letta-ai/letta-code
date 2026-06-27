import type Letta from "@letta-ai/letta-client";
import { getBackend } from "@/backend";
import { buildModInvocationContext } from "@/mods/context";
import { createModAdapter, type ModAdapter } from "@/mods/mod-adapter";
import type { ModCapabilities, ModContext } from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import type { ListenerRuntime } from "./types";

export const LISTENER_MOD_CAPABILITIES: ModCapabilities = {
  tools: true,
  commands: true,
  events: {
    lifecycle: false,
    tools: true,
    turns: true,
    compact: false,
    llm: false,
  },
  permissions: false,
  providers: true,
  ui: {
    panels: false,
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
  throw new Error("letta.client is not available in listener mods");
}

export function createListenerModContext(
  options: Pick<
    CreateListenerModAdapterOptions,
    "sessionId" | "workingDirectory"
  > & {
    agent?: {
      id: string;
      name?: string | null;
      model?: string | null;
      llm_config?: {
        model?: string | null;
        model_endpoint_type?: string | null;
        reasoning_effort?: string | null;
      } | null;
    } | null;
    modelIdentifier?: string | null;
    permissionMode?: string | null;
    toolset?: string | null;
  } = {},
): ModContext {
  const cwd = options.workingDirectory ?? getCurrentWorkingDirectory();
  return buildModInvocationContext({
    agent: options.agent ?? null,
    conversationId: options.sessionId ?? null,
    modelIdentifier: options.modelIdentifier ?? null,
    permissionMode: options.permissionMode ?? null,
    toolset: options.toolset ?? null,
    workingDirectory: cwd,
  });
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
  await adapter.reload();
}

export function disposeListenerModAdapter(runtime: ListenerRuntime): void {
  runtime.modAdapter?.dispose();
  runtime.modAdapter = undefined;
}
