import {
  getActiveRuntime,
  getLatestRuntimeAuthorityEpoch,
  getRuntimeAuthorityEpoch,
} from "./runtime";
import { resolveStartupLineageId } from "./startup-ingress";
import type {
  ListenerClientReplacement,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

/**
 * Why a replacement token is not adoptable. Reported in the thrown message so
 * a rejected re-registration is diagnosable without leaking token contents.
 */
type ListenerReplacementRejection =
  | "unknown_provenance"
  | "identity_mismatch"
  | "stale_generation"
  | "unauthoritative_issuer";

type ListenerReplacementProvenance = {
  issuer: ListenerRuntime;
  deviceId: string;
  connectionName: string;
  lineageId: string;
  generation: number;
  authorityEpoch: number | null;
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

function rejectReplacement(reason: ListenerReplacementRejection): never {
  throw new Error(`Invalid listener replacement lineage: ${reason}`);
}

export function createListenerClientReplacement(
  runtime: ListenerRuntime,
  opts: StartListenerOptions,
): ListenerClientReplacement {
  const lineageId = resolveStartupLineageId(runtime, opts);
  const generation = runtime.startupGenerationByLineage.get(lineageId) ?? 0;
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
  if (issuer.intentionallyClosed || issuer !== getActiveRuntime()) {
    rejectReplacement("unauthoritative_issuer");
  }
  return provenance;
}

/** Consume the registration handoff without replacing its live runtime. */
export function adoptListenerClientReplacement(
  opts: StartListenerOptions,
): ListenerRuntime | null {
  const provenance = resolveAdoptableReplacement(opts);
  if (!provenance || !opts.replacement) return null;
  replacementProvenance.delete(opts.replacement);
  return provenance.issuer;
}
