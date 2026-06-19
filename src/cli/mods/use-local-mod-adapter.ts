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
  context: ModContext;
  events: ModAdapter["events"];
  getBackend: ModAdapter["getBackend"];
  hadStatuslineRenderer: boolean; // Used to prevent flicker on reload
  hasModSources: boolean;
  engine: ModAdapter["engine"];
  isLoading: boolean;
  registry: ModAdapterSnapshot["registry"];
  reload: () => Promise<void>;
}

export function useLocalModAdapter(
  context: ModContext,
  options: { disabled?: boolean } = {},
): LocalModAdapter {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the adapter is process-local; context updates are pushed through updateContext below.
  const adapter = useMemo(
    () =>
      createModAdapter({
        disabled: options.disabled,
        getBackend,
        getClient,
      }),
    [],
  );

  const snapshot = useSyncExternalStore(
    adapter.subscribe,
    adapter.getSnapshot,
    adapter.getSnapshot,
  );

  useEffect(() => {
    void adapter.reload();

    return () => {
      adapter.dispose();
    };
  }, [adapter]);

  return useMemo(
    () => ({
      context,
      events: adapter.events,
      getBackend: adapter.getBackend,
      hadStatuslineRenderer: snapshot.hadStatuslineRenderer,
      hasModSources: snapshot.hasModSources,
      engine: adapter.engine,
      isLoading: snapshot.isLoading,
      registry: snapshot.registry,
      reload: adapter.reload,
    }),
    [adapter, context, snapshot],
  );
}
