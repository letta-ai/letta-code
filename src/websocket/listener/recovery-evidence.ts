import {
  type ListenerStateWritePhase,
  recordListenerWork,
} from "./interrupted-turn-record";
import type { ListenerTransport } from "./transport";
import type { TurnCorrelation } from "./turn-correlation";
import type { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import type { TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime, IncomingMessage } from "./types";

export type RecoveredContinuationProcessTurn = (
  msg: IncomingMessage,
  socket: ListenerTransport,
  runtime: ConversationRuntime,
  onStatusChange?: (
    status: "idle" | "receiving" | "processing",
    connectionId: string,
  ) => void,
  connectionId?: string,
  dequeuedBatchId?: string,
  existingTurnLease?: TurnLease,
  existingTurnCorrelation?: TurnCorrelation,
  terminalCommitGuard?: () => boolean,
  retainRecoveredApprovalState?: boolean,
  initialInterruptedRevision?: string,
  deferInterruptedCleanup?: boolean,
  recoveryLineageId?: string,
) => Promise<void>;

export type RecoveryEvidenceWriter = (
  ...args: Parameters<typeof recordListenerWork>
) => unknown;

export function createRecoveryEvidenceCheckpoint(
  runtime: ConversationRuntime,
  writer: RecoveryEvidenceWriter = recordListenerWork,
  initialRevision?: string,
  recoveryLineageId?: string,
) {
  let revision = initialRevision;
  let hasWritten = initialRevision !== undefined;
  const write = (
    update: Parameters<typeof recordListenerWork>[1],
    phase: ListenerStateWritePhase,
  ) => {
    const next = hasWritten
      ? writer(runtime, update, phase, revision ?? null, recoveryLineageId)
      : writer(runtime, update, phase, undefined, recoveryLineageId);
    hasWritten = true;
    if (typeof next === "string") revision = next;
  };
  return {
    write,
    checkpointOwnership(
      ownership: ReturnType<typeof createTurnDurabilityOwnership>,
      actingUserId?: string,
    ) {
      write(
        {
          durableInputIdentities: [...ownership.durableInputIdentities],
          terminalConsumerIds: [...ownership.terminalConsumerIds],
          // An unattributed queued user is authoritative too: explicitly clear
          // any actor inherited from the earlier input in this recovery chain.
          actingUserId,
        },
        "run_observed",
      );
    },
    get revision() {
      return revision;
    },
  };
}
