import type { RecoveryLineageSidecar } from "./recovery-lineage-sidecar";
import type { AcceptedInputDispositionEntry } from "./types";

export function quarantineReferencesRetiredSidecar(
  quarantine: NonNullable<
    AcceptedInputDispositionEntry["legacyAuthorityQuarantine"]
  >,
  retired: RecoveryLineageSidecar,
  interruptedRevision: string,
): boolean {
  return (
    quarantine.scope.agentId === retired.agentId &&
    quarantine.scope.conversationId === retired.conversationId &&
    quarantine.recoveryLineageId === retired.lineageId &&
    quarantine.interruptedRevision === interruptedRevision
  );
}

export function findRetiredSidecarQuarantine(
  quarantines: readonly NonNullable<
    AcceptedInputDispositionEntry["legacyAuthorityQuarantine"]
  >[],
  retired: RecoveryLineageSidecar,
  interruptedRevision: string,
) {
  return quarantines.find((quarantine) =>
    quarantineReferencesRetiredSidecar(
      quarantine,
      retired,
      interruptedRevision,
    ),
  );
}
