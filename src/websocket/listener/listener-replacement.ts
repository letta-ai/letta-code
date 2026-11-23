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
  if (
    (issuer.startupGenerationByLineage.get(provenance.lineageId) ?? 0) !==
    provenance.generation
  ) {
    rejectReplacement("stale_generation");
  }
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

export function adoptListenerClientReplacement(
  opts: StartListenerOptions,
): ListenerRuntime | null {
  const provenance = resolveAdoptableReplacement(opts);
  if (!provenance || !opts.replacement) return null;
  replacementProvenance.delete(opts.replacement);
  return provenance.issuer;
}
