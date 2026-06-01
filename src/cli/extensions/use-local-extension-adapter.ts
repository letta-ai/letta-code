import { useEffect, useMemo, useSyncExternalStore } from "react";
import { sendMessageStreamWithBackend } from "@/agent/message";
import { type Backend, getBackend } from "@/backend";
import { getClient } from "@/backend/api/client";
import { loadExtensionConversationHistoryFromBackend } from "@/extensions/conversation-history";
import type { ExtensionAdapterBackendApi } from "@/extensions/types";
import {
  createExtensionAdapter,
  type ExtensionAdapter,
  type ExtensionAdapterSnapshot,
} from "./local-extension-loader";
import type {
  ExtensionContext,
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "./types";

export interface LocalExtensionAdapter {
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  eventEmitter: ExtensionAdapter["eventEmitter"];
  getBackendApi: () => ExtensionAdapterBackendApi | undefined;
  getContext: () => ExtensionContext;
  hadStatuslineRenderer: boolean; // Used to prevent flicker on reload
  hasExtensionSources: boolean;
  engine: ExtensionAdapter["engine"];
  isLoading: boolean;
  registry: ExtensionAdapterSnapshot["registry"];
  reload: () => Promise<void>;
  updateContext: (context: ExtensionContext) => void;
}

function createExtensionBackendApi(
  backend: Backend,
): ExtensionAdapterBackendApi {
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

export function useLocalExtensionAdapter(
  initialContext: ExtensionContext,
  options: { disabled?: boolean } = {},
): LocalExtensionAdapter {
  // biome-ignore lint/correctness/useExhaustiveDependencies: the adapter is process-local; context updates are pushed through updateContext below.
  const adapter = useMemo(
    () =>
      createExtensionAdapter({
        disabled: options.disabled,
        getBackendApi: () => createExtensionBackendApi(getBackend()),
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
      emitEvent: adapter.emitEvent,
      eventEmitter: adapter.eventEmitter,
      getBackendApi: adapter.getBackendApi,
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
