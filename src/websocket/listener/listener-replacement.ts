import type {
  ListenerClientReplacement,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

const issuedListenerReplacements = new WeakSet<ListenerClientReplacement>();

export function createListenerClientReplacement(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
): ListenerClientReplacement {
  const connection = runtime.connections.get(opts.connectionId);
  const lineageId = connection?.startupLineageId ?? opts.connectionId;
  const replacement = Object.freeze({
    deviceId: opts.deviceId,
    connectionName: opts.connectionName,
    lineageId,
    generation: runtime.startupGenerationByLineage.get(lineageId) ?? 0,
    ledger: runtime.acceptedInputDispositionLedger,
    startupFrames: [
      ...(runtime.pendingStartupFramesByLineage.get(lineageId) ?? []),
    ],
  });
  issuedListenerReplacements.add(replacement);
  return replacement;
}

export function adoptListenerClientReplacement(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
): void {
  const replacement = opts.replacement;
  if (!replacement) return;
  if (
    !issuedListenerReplacements.has(replacement) ||
    replacement.deviceId !== opts.deviceId ||
    replacement.connectionName !== opts.connectionName
  ) {
    throw new Error("Invalid listener replacement lineage");
  }
  issuedListenerReplacements.delete(replacement);
  runtime.acceptedInputDispositionLedger = replacement.ledger;
  runtime.startupGenerationByLineage.set(
    replacement.lineageId,
    replacement.generation,
  );
  if (replacement.startupFrames.length > 0) {
    runtime.pendingStartupFramesByLineage.set(replacement.lineageId, [
      ...replacement.startupFrames,
    ]);
  }
}
