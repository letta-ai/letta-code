import { useEffect, useMemo, useSyncExternalStore } from "react";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { type Backend, getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { loadExtensionConversationHistoryFromBackend } from "@/extensions/conversation-history";
import type { ExtensionRuntimeBackendApi } from "@/extensions/types";
import {
  createExtensionRuntime,
  type ExtensionRuntime,
  type ExtensionRuntimeSnapshot,
} from "./local-extension-loader";
import type {
  ExtensionContext,
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "./types";

export interface LocalExtensionRuntime {
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  getBackendApi: () => ExtensionRuntimeBackendApi | undefined;
  getContext: () => ExtensionContext;
  hadStatuslineRenderer: boolean;
  hasExtensionSources: boolean;
  host: ExtensionRuntime["host"];
  isLoading: boolean;
  registry: ExtensionRuntimeSnapshot["registry"];
  reload: () => Promise<void>;
  updateContext: (context: ExtensionContext) => void;
}

function createExtensionBackendApi(
  backend: Backend,
): ExtensionRuntimeBackendApi {
  return {
    forkConversation(conversationId, options) {
      return backend.forkConversation(conversationId, options);
    },
    getConversationHistory(conversationId, options) {
      return loadExtensionConversationHistoryFromBackend(
        backend,
        {
          agentId: options?.agentId,
          conversationId,
        },
        options,
      );
    },
    sendMessageStream(conversationId, messages, options, requestOptions) {
      return sendMessageStreamWithBackend(
        backend,
        conversationId,
        messages,
        options,
        requestOptions,
      );
    },
  };
}

export function useLocalExtensionRuntime(
  initialContext: ExtensionContext,
): LocalExtensionRuntime {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the runtime is process-local; context updates are pushed through updateContext below.
  const runtime = useMemo(
    () =>
      createExtensionRuntime({
        getBackendApi: () => createExtensionBackendApi(getBackend()),
        getClient,
        initialContext,
      }),
    [],
  );

  const snapshot = useSyncExternalStore(
    runtime.subscribe,
    runtime.getSnapshot,
    runtime.getSnapshot,
  );

  useEffect(() => {
    runtime.updateContext(initialContext);
  }, [initialContext, runtime]);

  useEffect(() => {
    void runtime.reload();

    return () => {
      runtime.dispose();
    };
  }, [runtime]);

  return useMemo(
    () => ({
      emitEvent: runtime.emitEvent,
      getBackendApi: runtime.getBackendApi,
      getContext: runtime.getContext,
      hadStatuslineRenderer: snapshot.hadStatuslineRenderer,
      hasExtensionSources: snapshot.hasExtensionSources,
      host: runtime.host,
      isLoading: snapshot.isLoading,
      registry: snapshot.registry,
      reload: runtime.reload,
      updateContext: runtime.updateContext,
    }),
    [runtime, snapshot],
  );
}
