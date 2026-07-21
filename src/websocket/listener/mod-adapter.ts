import { createHash } from "node:crypto";
import { join } from "node:path";
import type Letta from "@letta-ai/letta-client";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { getBackend } from "@/backend";
import { buildModInvocationContext } from "@/mods/context";
import type { ModEvents } from "@/mods/event-emitter";
import { createModAdapter, type ModAdapter } from "@/mods/mod-adapter";
import { getModCacheDirectory } from "@/mods/paths";
import type {
  ModCapabilities,
  ModContext,
  ModEventEmissionResult,
  ModEventMap,
  ModEventName,
} from "@/mods/types";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { getBootWorkingDirectory } from "./cwd";
import { ensureMemfsSyncedForAgent } from "./memfs-sync";
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
  permissions: true,
  providers: true,
  ui: {
    panels: false,
  },
};

const LISTENER_AGENT_MOD_CAPABILITIES: ModCapabilities = {
  ...LISTENER_MOD_CAPABILITIES,
  // Provider registration is process-global and cannot be isolated per agent.
  providers: false,
};

export interface CreateListenerModAdapterOptions {
  agentModsDirectory?: string;
  cacheDirectory?: string;
  capabilities?: ModCapabilities;
  diagnosticsRootDirectory?: string;
  disabled?: boolean;
  globalModsDirectory?: string;
  includeGlobalMods?: boolean;
  registerCapabilitiesGlobally?: boolean;
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
    ...(options.agentModsDirectory
      ? { agentModsDirectory: options.agentModsDirectory }
      : {}),
    ...(options.cacheDirectory
      ? { cacheDirectory: options.cacheDirectory }
      : {}),
    capabilities: options.capabilities ?? LISTENER_MOD_CAPABILITIES,
    ...(options.diagnosticsRootDirectory
      ? { diagnosticsRootDirectory: options.diagnosticsRootDirectory }
      : {}),
    disabled: options.disabled,
    getBackend,
    getClient: getUnavailableListenerClient,
    ...(options.globalModsDirectory
      ? { globalModsDirectory: options.globalModsDirectory }
      : {}),
    ...(options.includeGlobalMods !== undefined
      ? { includeGlobalMods: options.includeGlobalMods }
      : {}),
    ...(options.registerCapabilitiesGlobally !== undefined
      ? {
          registerCapabilitiesGlobally: options.registerCapabilitiesGlobally,
        }
      : {}),
  });
}

export function ensureListenerModAdapter(runtime: ListenerRuntime): ModAdapter {
  runtime.modAdapter ??= createListenerModAdapter({
    sessionId: runtime.sessionId,
    workingDirectory: getBootWorkingDirectory(runtime),
  });
  return runtime.modAdapter;
}

function resolveListenerAgentModsDirectory(agentId: string): string | null {
  try {
    return settingsManager.isMemfsEnabled(agentId)
      ? join(getScopedMemoryFilesystemRoot(agentId), "mods")
      : null;
  } catch {
    return null;
  }
}

function resolveListenerAgentModCacheDirectory(agentId: string): string {
  // A distinct import path gives each agent its own ESM module instance while
  // keeping generated files outside the git-backed MemFS repository.
  const cacheKey = createHash("sha256").update(agentId).digest("hex");
  return join(getModCacheDirectory(), "listener-agents", cacheKey);
}

let resolveAgentModsDirectory = resolveListenerAgentModsDirectory;
let resolveAgentModCacheDirectory = resolveListenerAgentModCacheDirectory;
let ensureAgentMemfsSynced = ensureMemfsSyncedForAgent;

export async function ensureListenerAgentModAdapter(
  runtime: ListenerRuntime,
  agentId: string,
): Promise<ModAdapter | null> {
  runtime.agentModAdapters ??= new Map();
  runtime.agentModAdapterLoads ??= new Map();
  const agentModAdapters = runtime.agentModAdapters;
  const agentModAdapterLoads = runtime.agentModAdapterLoads;
  const existing = agentModAdapters.get(agentId);
  if (existing) return existing;

  const pending = agentModAdapterLoads.get(agentId);
  if (pending) return pending;

  let load: Promise<ModAdapter | null> | undefined;
  load = (async () => {
    try {
      const syncSucceeded = await ensureAgentMemfsSynced(runtime, agentId);
      if (!syncSucceeded || agentModAdapterLoads.get(agentId) !== load) {
        return null;
      }

      const agentModsDirectory = resolveAgentModsDirectory(agentId);
      if (!agentModsDirectory) return null;

      const adapter = createListenerModAdapter({
        agentModsDirectory,
        cacheDirectory: resolveAgentModCacheDirectory(agentId),
        capabilities: LISTENER_AGENT_MOD_CAPABILITIES,
        includeGlobalMods: false,
        registerCapabilitiesGlobally: false,
        sessionId: runtime.sessionId,
        workingDirectory: runtime.bootWorkingDirectory,
      });
      try {
        await adapter.reload();
        if (agentModAdapterLoads.get(agentId) !== load) {
          adapter.dispose();
          return null;
        }
        agentModAdapters.set(agentId, adapter);
        return adapter;
      } catch (error) {
        adapter.dispose();
        throw error;
      }
    } finally {
      if (agentModAdapterLoads.get(agentId) === load) {
        agentModAdapterLoads.delete(agentId);
      }
    }
  })();

  agentModAdapterLoads.set(agentId, load);
  return load;
}

export async function ensureListenerModAdaptersForAgent(
  runtime: ListenerRuntime,
  agentId: string,
): Promise<ModAdapter[]> {
  const globalAdapter = ensureListenerModAdapter(runtime);
  const agentAdapter = await ensureListenerAgentModAdapter(runtime, agentId);
  return agentAdapter ? [globalAdapter, agentAdapter] : [globalAdapter];
}

export function getLoadedListenerModAdapters(
  runtime: ListenerRuntime,
  agentId?: string | null,
): ModAdapter[] {
  const adapters = runtime.modAdapter ? [runtime.modAdapter] : [];
  const agentAdapter = agentId
    ? runtime.agentModAdapters?.get(agentId)
    : undefined;
  if (agentAdapter) adapters.push(agentAdapter);
  return adapters;
}

export function createListenerModEvents(adapters: ModAdapter[]): ModEvents {
  return {
    async emit<TName extends ModEventName>(
      name: TName,
      event: ModEventMap[TName],
      context: ModContext,
    ) {
      const combined: ModEventEmissionResult<TName> = {
        diagnostics: [],
        handlerCount: 0,
        name,
        results: [],
      };
      for (const adapter of adapters) {
        const result = await adapter.events.emit(name, event, context);
        combined.diagnostics.push(...result.diagnostics);
        combined.handlerCount += result.handlerCount;
        combined.results.push(...result.results);
      }
      return combined;
    },
  };
}

export async function reloadListenerModAdapter(
  runtime: ListenerRuntime,
  agentId?: string | null,
): Promise<void> {
  const adapter = ensureListenerModAdapter(runtime);
  await adapter.reload();

  if (!agentId) return;
  const agentAdapter = runtime.agentModAdapters?.get(agentId);
  if (!resolveAgentModsDirectory(agentId)) {
    agentAdapter?.dispose();
    runtime.agentModAdapters?.delete(agentId);
    return;
  }
  if (agentAdapter) {
    await agentAdapter.reload();
    return;
  }
  await ensureListenerAgentModAdapter(runtime, agentId);
}

export const __listenerModAdapterTestUtils = {
  setAgentModsDirectoryResolverForTests(
    resolver: (agentId: string) => string | null,
  ): void {
    resolveAgentModsDirectory = resolver;
  },
  setAgentModCacheDirectoryResolverForTests(
    resolver: (agentId: string) => string,
  ): void {
    resolveAgentModCacheDirectory = resolver;
  },
  setEnsureMemfsSyncedForAgentForTests(
    ensureSynced: typeof ensureMemfsSyncedForAgent,
  ): void {
    ensureAgentMemfsSynced = ensureSynced;
  },
  resetForTests(): void {
    resolveAgentModsDirectory = resolveListenerAgentModsDirectory;
    resolveAgentModCacheDirectory = resolveListenerAgentModCacheDirectory;
    ensureAgentMemfsSynced = ensureMemfsSyncedForAgent;
  },
};

export function disposeListenerModAdapter(runtime: ListenerRuntime): void {
  runtime.modAdapter?.dispose();
  runtime.modAdapter = undefined;
  for (const adapter of runtime.agentModAdapters?.values() ?? []) {
    adapter.dispose();
  }
  runtime.agentModAdapters?.clear();
  for (const [agentId, pending] of runtime.agentModAdapterLoads?.entries() ??
    []) {
    void pending.then((adapter) => {
      adapter?.dispose();
      runtime.agentModAdapters?.delete(agentId);
    });
  }
  runtime.agentModAdapterLoads?.clear();
}
