import type {
  ExtensionEventEmissionResult,
  ExtensionEventMap,
  ExtensionEventName,
} from "@/extensions/types";

// Narrow event capability exposed by the extension adapter. Adapter-owned
// implementations are guarded, so lower layers can emit events without
// depending on adapter lifecycle or registry APIs.
export type ExtensionEvents = {
  emit: <TName extends ExtensionEventName>(
    name: TName,
    event: ExtensionEventMap[TName],
  ) => Promise<ExtensionEventEmissionResult<TName>>;
};

export function emptyEventEmissionResult<TName extends ExtensionEventName>(
  name: TName,
): ExtensionEventEmissionResult<TName> {
  return { diagnostics: [], handlerCount: 0, name, results: [] };
}

export async function emitExtensionEvent<TName extends ExtensionEventName>(
  events: ExtensionEvents | undefined,
  name: TName,
  event: ExtensionEventMap[TName],
): Promise<ExtensionEventEmissionResult<TName>> {
  if (!events) {
    return emptyEventEmissionResult(name);
  }

  return events.emit(name, event);
}
