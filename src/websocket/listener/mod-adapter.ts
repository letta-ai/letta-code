import { getBackend } from "@/backend";
import type { ModAdapter } from "@/mods/mod-adapter";
import {
  createProviderOnlyModAdapter,
  createProviderOnlyModContext,
  PROVIDER_ONLY_MOD_CAPABILITIES,
} from "@/mods/provider-mod-adapter";
import type { ModContext } from "@/mods/types";
import type { ListenerRuntime } from "./types";

export const LISTENER_MOD_CAPABILITIES = PROVIDER_ONLY_MOD_CAPABILITIES;

export interface CreateListenerModAdapterOptions {
  cacheDirectory?: string;
  diagnosticsRootDirectory?: string;
  disabled?: boolean;
  globalModsDirectory?: string;
  sessionId?: string | null;
  workingDirectory?: string | null;
}

export function createListenerModContext(
  options: Pick<
    CreateListenerModAdapterOptions,
    "sessionId" | "workingDirectory"
  > = {},
): ModContext {
  return createProviderOnlyModContext(options);
}

export function createListenerModAdapter(
  options: CreateListenerModAdapterOptions = {},
): ModAdapter {
  return createProviderOnlyModAdapter({
    ...options,
    getBackend,
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
