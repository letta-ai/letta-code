import type {
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "@/extensions/types";

type ExtensionRuntimeEventSnapshot = {
  hasExtensionSources: boolean;
  isLoading: boolean;
};

type ExtensionEventEmitter = {
  emitEvent: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
  getSnapshot: () => ExtensionRuntimeEventSnapshot;
};

type RegisteredExtensionEventEmitter = ExtensionEventEmitter & {
  id: number;
};

const EXTENSION_EVENT_EMITTERS_KEY = Symbol.for(
  "@letta/extensionEventEmitters",
);

type GlobalWithExtensionEventEmitters = typeof globalThis & {
  [EXTENSION_EVENT_EMITTERS_KEY]?: RegisteredExtensionEventEmitter[];
};

let nextEmitterId = 0;

function getExtensionEventEmitters(): RegisteredExtensionEventEmitter[] {
  const global = globalThis as GlobalWithExtensionEventEmitters;
  if (!global[EXTENSION_EVENT_EMITTERS_KEY]) {
    global[EXTENSION_EVENT_EMITTERS_KEY] = [];
  }
  return global[EXTENSION_EVENT_EMITTERS_KEY];
}

function emptyEventEmissionResult<TName extends ExtensionEventName>(
  name: TName,
): ExtensionEventEmissionResult<TName> {
  return { diagnostics: [], handlerCount: 0, name, results: [] };
}

export function registerExtensionEventEmitter(
  emitter: ExtensionEventEmitter,
): () => void {
  const registered = { ...emitter, id: nextEmitterId++ };
  getExtensionEventEmitters().push(registered);

  return () => {
    const emitters = getExtensionEventEmitters();
    const index = emitters.findIndex((entry) => entry.id === registered.id);
    if (index !== -1) {
      emitters.splice(index, 1);
    }
  };
}

export async function emitActiveExtensionEvent<
  TName extends ExtensionEventName,
>(
  name: TName,
  event: ExtensionEventMap[TName],
): Promise<ExtensionEventEmissionResult<TName>> {
  const emitters = getExtensionEventEmitters();
  const emitter = emitters.at(-1);
  if (!emitter) {
    return emptyEventEmissionResult(name);
  }

  const snapshot = emitter.getSnapshot();
  if (snapshot.isLoading || !snapshot.hasExtensionSources) {
    return emptyEventEmissionResult(name);
  }

  return emitter.emitEvent(name, event);
}
