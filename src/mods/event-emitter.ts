import type {
  ModContext,
  ModEventEmissionResult,
  ModEventMap,
  ModEventName,
} from "@/mods/types";

// Narrow event capability exposed by the mod adapter. Adapter-owned
// implementations are guarded, so lower layers can emit events without
// depending on adapter lifecycle or registry APIs.
export type ModEvents = {
  emit: <TName extends ModEventName>(
    name: TName,
    event: ModEventMap[TName],
    context: ModContext,
  ) => Promise<ModEventEmissionResult<TName>>;
};

export function emptyEventEmissionResult<TName extends ModEventName>(
  name: TName,
): ModEventEmissionResult<TName> {
  return { diagnostics: [], handlerCount: 0, name, results: [] };
}

export async function emitModEvent<TName extends ModEventName>(
  events: ModEvents | undefined,
  name: TName,
  event: ModEventMap[TName],
  context: ModContext,
): Promise<ModEventEmissionResult<TName>> {
  if (!events) {
    return emptyEventEmissionResult(name);
  }

  return events.emit(name, event, context);
}
