import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { debugLog } from "@/utils/debug";
import {
  createExtensionHost,
  type ExtensionHost,
  resolveLocalExtensionSources,
} from "./local-extension-loader";
import type { ExtensionBackendApi, ExtensionContext } from "./types";

export interface LocalExtensionRuntime {
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  host: ExtensionHost;
  isLoading: boolean;
  registry: ReturnType<ExtensionHost["getSnapshot"]> | null;
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
  const [loadState, setLoadState] = useState<LocalExtensionLoadState>(() => {
    const hasExtensionSources = hasLocalExtensionSources();
    return {
      hadStatuslineRenderer: false,
      hasExtensionSources,
      isLoading: hasExtensionSources,
    };
  });
  const loadStateRef = useRef(loadState);

  useEffect(() => {
    loadStateRef.current = loadState;
  }, [loadState]);

  const updateContext = useCallback((context: ExtensionContext) => {
    contextRef.current = context;
  }, []);

  const getContext = useCallback(() => contextRef.current, []);

  const backend = useMemo<ExtensionBackendApi>(() => {
    return {
      forkConversation(conversationId, options) {
        return getBackend().forkConversation(conversationId, options);
      },
      sendMessageStream(conversationId, messages, options, requestOptions) {
        return sendMessageStreamWithBackend(
          getBackend(),
          conversationId,
          messages,
          options,
          requestOptions,
        );
      },
    };
  }, []);

  const host = useMemo(
    () =>
      createExtensionHost({
        backend,
        getClient,
        getContext,
      }),
    [backend, getContext],
  );

  const registry = useSyncExternalStore(
    host.subscribe,
    host.getSnapshot,
    host.getSnapshot,
  );

  useEffect(() => {
    contextRef.current = initialContext;
  }, [initialContext]);

  const reload = useCallback(async () => {
    const previousSnapshot = host.getSnapshot();
    const previousHadStatuslineRenderer =
      Boolean(previousSnapshot.ui.statuslineRenderer) ||
      loadStateRef.current.hadStatuslineRenderer;
    const hasExtensionSources = hasLocalExtensionSources();
    setLoadState({
      hadStatuslineRenderer: previousHadStatuslineRenderer,
      hasExtensionSources,
      isLoading: true,
    });

    await host.reload();
    const nextRegistry = host.getSnapshot();

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
      host.dispose();
      return;
    }

    const nextHasExtensionSources = nextRegistry.sources.some(
      (source) => source.files.length > 0,
    );
    const nextHadStatuslineRenderer = Boolean(
      nextRegistry.ui.statuslineRenderer,
    );

    setLoadState({
      hadStatuslineRenderer: nextHadStatuslineRenderer,
      hasExtensionSources: nextHasExtensionSources,
      isLoading: false,
    });
  }, [host]);

  useEffect(() => {
    mountedRef.current = true;
    void reload();

    return () => {
      mountedRef.current = false;
      host.dispose();
    };
  }, [host, reload]);

  return useMemo(
    () => ({
      registry,
      getContext,
      host,
      reload,
      updateContext,
      ...loadState,
    }),
    [getContext, host, loadState, registry, reload, updateContext],
  );
}
