import { useEffect, useMemo, useSyncExternalStore } from "react";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import {
  createModAdapter,
  type ModAdapter,
  type ModAdapterSnapshot,
} from "./local-mod-loader";
import type { ModContext } from "./types";

export interface LocalModAdapter {
  events: ModAdapter["events"];
  getBackend: ModAdapter["getBackend"];
  getContext: () => ModContext;
  hadStatuslineRenderer: boolean; // Used to prevent flicker on reload
  hasModSources: boolean;
  engine: ModAdapter["engine"];
  isLoading: boolean;
  registry: ModAdapterSnapshot["registry"];
  reload: () => Promise<void>;
  updateContext: (context: ModContext) => void;
}

export function useLocalModAdapter(
  initialContext: ModContext,
  options: { disabled?: boolean } = {},
): LocalModAdapter {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the adapter is process-local; context updates are pushed through updateContext below.
  const adapter = useMemo(
    () =>
      createModAdapter({
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
      hasModSources: snapshot.hasModSources,
      engine: adapter.engine,
      isLoading: snapshot.isLoading,
      registry: snapshot.registry,
      reload: adapter.reload,
      updateContext: adapter.updateContext,
    }),
    [adapter, snapshot],
  );
}
