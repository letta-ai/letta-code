import {
  getActiveRuntime,
  getLatestRuntimeAuthorityEpoch,
  getRuntimeAuthorityEpoch,
} from "./runtime";
import { resolveStartupLineageId } from "./startup-ingress";
import { cloneTurnCorrelationIndex } from "./turn-correlation";
import type {
  AcceptedInputDispositionLedger,
  ListenerClientReplacement,
  ListenerRuntime,
  StartListenerOptions,
  StartupFrameHandoff,
} from "./types";

/**
 * Why a replacement token is not adoptable. Reported in the thrown message so
 * a rejected re-registration is diagnosable without leaking token contents.
 */
type ListenerReplacementRejection =
  | "unknown_provenance"
  | "identity_mismatch"
  | "superseded_issuer"
  | "stale_generation"
  | "unauthoritative_issuer";

type ListenerReplacementProvenance = {
  issuer: ListenerRuntime;
  deviceId: string;
  connectionName: string;
  lineageId: string;
  generation: number;
  authorityEpoch: number | null;
  ledger: AcceptedInputDispositionLedger;
  startupFrameHandoff: StartupFrameHandoff;
  clientMessageIdsByRunIdByConversation: Map<string, Map<string, string[]>>;
};

/**
 * Private provenance for every issued token. Adoption is authorized by this
 * table alone — never by the token's own fields — so a structural clone, a
 * hand-built object, or a replay of an already-consumed token cannot transfer
 * accepted-input ownership.
 */
const replacementProvenance = new WeakMap<
  ListenerClientReplacement,
  ListenerReplacementProvenance
>();

/** Predecessors that already handed their ownership to a successor runtime. */
const succeededListenerRuntimes = new WeakSet<ListenerRuntime>();

function rejectReplacement(reason: ListenerReplacementRejection): never {
  throw new Error(`Invalid listener replacement lineage: ${reason}`);
}

function cloneRawData(frame: import("ws").RawData): import("ws").RawData {
  if (Array.isArray(frame)) return frame.map((chunk) => Buffer.from(chunk));
  if (Buffer.isBuffer(frame)) return Buffer.from(frame);
  if (frame instanceof ArrayBuffer) return frame.slice(0);
  return Buffer.from(new Uint8Array(frame));
}

function cloneStartupFrameHandoff(
  handoff: StartupFrameHandoff,
): StartupFrameHandoff {
  return handoff.kind === "overflow"
    ? { ...handoff }
    : { ...handoff, frames: handoff.frames.map(cloneRawData) };
}

function cloneDispositionLedger(
  ledger: AcceptedInputDispositionLedger,
): AcceptedInputDispositionLedger {
  return {
    entries: new Map(
      [...ledger.entries].map(([key, entry]) => [key, structuredClone(entry)]),
    ),
    scopeCounts: new Map(ledger.scopeCounts),
    expiryQueue: ledger.expiryQueue.map((entry) => ({ ...entry })),
    expiryQueueHead: ledger.expiryQueueHead,
    nextGeneration: ledger.nextGeneration,
    persistentPath: ledger.persistentPath,
  };
}

export function createListenerClientReplacement(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
): ListenerClientReplacement {
  const lineageId = resolveStartupLineageId(runtime, opts);
  const generation = runtime.startupGenerationByLineage.get(lineageId) ?? 0;
  const startupFrameHandoff = cloneStartupFrameHandoff(
    runtime.pendingStartupFramesByLineage.get(lineageId) ?? {
      kind: "frames",
      frames: [],
      byteLength: 0,
    },
  );
  const clientMessageIdsByRunIdByConversation = cloneTurnCorrelationIndex(
    runtime.clientMessageIdsByRunIdByConversation,
  );
  const replacement = Object.freeze({
    deviceId: opts.deviceId,
    connectionName: opts.connectionName,
    lineageId,
    generation,
  });
  replacementProvenance.set(replacement, {
    issuer: runtime,
    deviceId: opts.deviceId,
    connectionName: opts.connectionName,
    lineageId,
    generation,
    authorityEpoch: getRuntimeAuthorityEpoch(runtime),
    ledger: cloneDispositionLedger(runtime.acceptedInputDispositionLedger),
    startupFrameHandoff: cloneStartupFrameHandoff(startupFrameHandoff),
    clientMessageIdsByRunIdByConversation: cloneTurnCorrelationIndex(
      clientMessageIdsByRunIdByConversation,
    ),
  });
  return replacement;
}

/**
 * Resolve the exact authoritative predecessor behind `opts.replacement`.
 *
 * Returns null when no token was supplied. Throws — without mutating anything
 * — when a token was supplied but is not adoptable, so a stale or replayed
 * token is rejected harmlessly instead of destroying a healthy runtime.
 */
function resolveAdoptableReplacement(
  opts: StartListenerOptions,
): ListenerReplacementProvenance | null {
  const replacement = opts.replacement;
  if (!replacement) return null;
  const provenance = replacementProvenance.get(replacement);
  if (!provenance) rejectReplacement("unknown_provenance");
  if (
    provenance.deviceId !== opts.deviceId ||
    provenance.connectionName !== opts.connectionName
  ) {
    rejectReplacement("identity_mismatch");
  }
  const issuer = provenance.issuer;
  if (succeededListenerRuntimes.has(issuer)) {
    rejectReplacement("superseded_issuer");
  }
  // The issuer must still own the generation it issued against. A late socket
  // that reconnected after the token was minted advances it, which makes the
  // token a stale view of a runtime that is once again serving.
  if (
    (issuer.startupGenerationByLineage.get(provenance.lineageId) ?? 0) !==
    provenance.generation
  ) {
    rejectReplacement("stale_generation");
  }
  // Clearing the active pointer for a stopped runtime does not erase history.
  // The issuer remains authoritative only until some different non-null runtime
  // becomes active, even if that newer runtime has also stopped by adoption.
  if (
    provenance.authorityEpoch === null ||
    provenance.authorityEpoch !== getLatestRuntimeAuthorityEpoch()
  ) {
    rejectReplacement("unauthoritative_issuer");
  }
  // 1008 tears the predecessor down before re-registering, so an intentionally
  // stopped runtime is the authoritative predecessor. A still-running issuer
  // only qualifies while it is the active runtime being replaced.
  const activeRuntime = getActiveRuntime();
  if (issuer.intentionallyClosed) {
    if (activeRuntime !== null && activeRuntime !== issuer) {
      rejectReplacement("unauthoritative_issuer");
    }
  } else if (issuer !== activeRuntime) {
    rejectReplacement("unauthoritative_issuer");
  }
  return provenance;
}

/**
 * Validate an inbound replacement token before any teardown happens.
 *
 * Callers must run this before stopping the runtime they are replacing: the
 * adoption below is what carries accepted-input ownership forward, and a
 * runtime stopped ahead of a failed validation can never get it back.
 */
export function assertAdoptableListenerClientReplacement(
  opts: StartListenerOptions,
): void {
  resolveAdoptableReplacement(opts);
}

export function adoptListenerClientReplacement(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
): void {
  const provenance = resolveAdoptableReplacement(opts);
  const replacement = opts.replacement;
  if (!provenance || !replacement) return;
  replacementProvenance.delete(replacement);
  succeededListenerRuntimes.add(provenance.issuer);
  runtime.acceptedInputDispositionLedger = cloneDispositionLedger(
    provenance.ledger,
  );
  runtime.clientMessageIdsByRunIdByConversation = cloneTurnCorrelationIndex(
    provenance.clientMessageIdsByRunIdByConversation,
  );
  runtime.startupGenerationByLineage.set(
    provenance.lineageId,
    provenance.generation,
  );
  if (
    provenance.startupFrameHandoff.kind === "overflow" ||
    provenance.startupFrameHandoff.frames.length > 0
  ) {
    runtime.pendingStartupFramesByLineage.set(
      provenance.lineageId,
      cloneStartupFrameHandoff(provenance.startupFrameHandoff),
    );
  }
}
