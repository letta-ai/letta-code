import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getClient } from "@/backend/api/client";
import { debugLog } from "@/utils/debug";
import {
  disposeLocalExtensions,
  type LocalExtensionRegistry,
  loadLocalExtensions,
  resolveLocalExtensionSources,
} from "./local-extension-loader";
import type { ExtensionContext } from "./types";

export interface LocalExtensionRuntime {
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  isLoading: boolean;
  registry: LocalExtensionRegistry | null;
  getContext: () => ExtensionContext;
  reload: () => Promise<void>;
  updateContext: (context: ExtensionContext) => void;
}

interface LocalExtensionLoadState {
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  isLoading: boolean;
}

function hasLocalExtensionSources(): boolean {
  return resolveLocalExtensionSources().some(
    (source) => source.files.length > 0,
  );
}

export function useLocalExtensionRuntime(
  initialContext: ExtensionContext,
): LocalExtensionRuntime {
  const contextRef = useRef(initialContext);
  const mountedRef = useRef(false);
  const registryRef = useRef<LocalExtensionRegistry | null>(null);
  const [registry, setRegistry] = useState<LocalExtensionRegistry | null>(null);
  const [loadState, setLoadState] = useState<LocalExtensionLoadState>(() => {
    const hasExtensionSources = hasLocalExtensionSources();
    return {
      hadStatuslineRenderer: false,
      hasExtensionSources,
      isLoading: hasExtensionSources,
    };
  });
  const loadStateRef = useRef(loadState);
  const [renderVersion, bumpRenderVersion] = useState(0);

  useEffect(() => {
    loadStateRef.current = loadState;
  }, [loadState]);

  const updateContext = useCallback((context: ExtensionContext) => {
    contextRef.current = context;
  }, []);

  const getContext = useCallback(() => contextRef.current, []);

  useEffect(() => {
    contextRef.current = initialContext;
  }, [initialContext]);

  const reload = useCallback(async () => {
    const previousHadStatuslineRenderer =
      Boolean(registryRef.current?.ui.statuslineRenderer) ||
      loadStateRef.current.hadStatuslineRenderer;
    const hasExtensionSources = hasLocalExtensionSources();
    setLoadState({
      hadStatuslineRenderer: previousHadStatuslineRenderer,
      hasExtensionSources,
      isLoading: true,
    });

    if (registryRef.current) {
      disposeLocalExtensions(registryRef.current);
      registryRef.current = null;
      setRegistry(null);
    }

    const nextRegistry = await loadLocalExtensions({
      getClient,
      getContext: () => contextRef.current,
      onChange: () => {
        if (mountedRef.current) {
          bumpRenderVersion((version) => version + 1);
        }
      },
    });

    debugLog(
      "extensions",
      "loaded %s extension(s) from %s source(s); renderer=%s",
      nextRegistry.loadedPaths.length,
      nextRegistry.sources.length,
      nextRegistry.ui.statuslineRenderer?.id ?? "(none)",
    );

    for (const loadError of nextRegistry.errors) {
      debugLog(
        "extensions",
        "failed to load %s: %s",
        loadError.path,
        loadError.error.message,
      );
    }

    if (!mountedRef.current) {
      disposeLocalExtensions(nextRegistry);
      return;
    }

    const nextHasExtensionSources = nextRegistry.sources.some(
      (source) => source.files.length > 0,
    );
    const nextHadStatuslineRenderer = Boolean(
      nextRegistry.ui.statuslineRenderer,
    );

    registryRef.current = nextRegistry;
    setRegistry(nextRegistry);
    setLoadState({
      hadStatuslineRenderer: nextHadStatuslineRenderer,
      hasExtensionSources: nextHasExtensionSources,
      isLoading: false,
    });
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void reload();

    return () => {
      mountedRef.current = false;
      if (registryRef.current) {
        disposeLocalExtensions(registryRef.current);
        registryRef.current = null;
      }
    };
  }, [reload]);

  return useMemo(() => {
    // Extension UI registries are mutated in place by trusted extension code.
    // Keep renderVersion private but include it here so onChange invalidates
    // the memoized runtime object and downstream components re-render.
    void renderVersion;
    return {
      registry,
      getContext,
      reload,
      updateContext,
      ...loadState,
    };
  }, [getContext, loadState, registry, reload, updateContext, renderVersion]);
}
