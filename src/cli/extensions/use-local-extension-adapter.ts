import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  createExtensionAdapter,
  type ExtensionAdapter,
  type ExtensionAdapterSnapshot,
} from "./local-extension-loader";
import type { ExtensionContext } from "./types";

export interface LocalExtensionAdapter {
  events: ExtensionAdapter["events"];
  getBackend: ExtensionAdapter["getBackend"];
  getContext: () => ExtensionContext;
  hadStatuslineRenderer: boolean; // Used to prevent flicker on reload
  hasExtensionSources: boolean;
  engine: ExtensionAdapter["engine"];
  isLoading: boolean;
  registry: ExtensionAdapterSnapshot["registry"];
  reload: () => Promise<void>;
  updateContext: (context: ExtensionContext) => void;
}

export function useLocalExtensionAdapter(
  initialContext: ExtensionContext,
  options: { disabled?: boolean } = {},
): LocalExtensionAdapter {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the adapter is process-local; context updates are pushed through updateContext below.
  const adapter = useMemo(
    () =>
      createExtensionAdapter({
        disabled: options.disabled,
        getBackend,
        getClient,
        initialContext,
      }),
    [],
  );

  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getSnapshot,
  );

  useEffect(() => {
    adapter.updateContext(initialContext);
  }, [initialContext, adapter]);

  useEffect(() => {
    void adapter.reload();

    return () => {
      adapter.dispose();
    };
  }, [adapter]);

  return useMemo(
    () => ({
      events: adapter.events,
      getBackend: adapter.getBackend,
      getContext: adapter.getContext,
      hadStatuslineRenderer: snapshot.hadStatuslineRenderer,
      hasExtensionSources: snapshot.hasExtensionSources,
      engine: adapter.engine,
      isLoading: snapshot.isLoading,
      registry: snapshot.registry,
      reload: adapter.reload,
      updateContext: adapter.updateContext,
    }),
    [adapter, snapshot],
  );
}
