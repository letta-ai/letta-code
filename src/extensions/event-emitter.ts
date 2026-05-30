import type {
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "@/extensions/types";

export type ExtensionRuntimeEventSnapshot = {
  hasExtensionSources: boolean;
  isLoading: boolean;
};

export type ExtensionEventEmitter = {
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  getSnapshot: () => ExtensionRuntimeEventSnapshot;
};

export function emptyEventEmissionResult<TName extends ExtensionEventName>(
  name: TName,
): ExtensionEventEmissionResult<TName> {
  return { diagnostics: [], handlerCount: 0, name, results: [] };
}

export async function emitExtensionEvent<TName extends ExtensionEventName>(
  emitter: ExtensionEventEmitter | undefined,
  name: TName,
  event: ExtensionEventMap[TName],
): Promise<ExtensionEventEmissionResult<TName>> {
  if (!emitter) {
    return emptyEventEmissionResult(name);
  }

  const snapshot = emitter.getSnapshot();
  if (snapshot.isLoading || !snapshot.hasExtensionSources) {
    return emptyEventEmissionResult(name);
  }

  return emitter.emitEvent(name, event);
}
