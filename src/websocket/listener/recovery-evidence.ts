import type { ApprovalResult } from "@/agent/approval-execution";
import {
  createInterruptedTurnStore,
  type ListenerStateWritePhase,
  type recordListenerWork,
  recordListenerWorkRetriably,
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
  recoveryTerminalRevision?: string,
  recoveryAuthorityStore?: RecoveryAuthorityStore,
  recoveryEvidenceWriter?: RecoveryEvidenceWriter,
) => Promise<void>;

export type RecoveryEvidenceWriter = (
  ...args: Parameters<typeof recordListenerWork>
) => unknown;

export type SettledRecoveryResultWriter = (
  runtime: ConversationRuntime,
  recoveryLineageId: string,
  result: ApprovalResult,
) =>
  | { revision: string; independentSuccessor: boolean }
  | Promise<{ revision: string; independentSuccessor: boolean }>;
export type RecoveryAuthorityStore = Pick<
  ReturnType<typeof createInterruptedTurnStore>,
  | "markRecoveryClaimCompletionPending"
  | "readRecoverySnapshot"
  | "retireRecoveryClaimCompletion"
  | "withRecoveryAuthority"
>;

export function createStoreBoundRecoveryEvidenceWriter(
  store: ReturnType<typeof createInterruptedTurnStore>,
  shouldContinue: () => boolean,
): RecoveryEvidenceWriter {
  return (runtime, update, phase, expectedRevision, recoveryLineageId) =>
    recordListenerWorkRetriably(
      runtime,
      update,
      phase,
      expectedRevision,
      recoveryLineageId,
      { store, shouldContinue },
    );
}

export async function mergeSettledRecoveryResultRetriably(
  store: ReturnType<typeof createInterruptedTurnStore>,
  params: Parameters<typeof store.mergeSettledRecoveryResult>[0],
  retryDelayMs = 10,
): Promise<ReturnType<typeof store.mergeSettledRecoveryResult>> {
  while (true) {
    try {
      return store.mergeSettledRecoveryResult(params);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "Timed out acquiring durable filesystem lock"
      ) {
        throw error;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}

export function createRecoveryEvidenceCheckpoint(
  runtime: ConversationRuntime,
  writer?: RecoveryEvidenceWriter,
  initialRevision?: string,
  recoveryLineageId?: string,
  settledResultWriter?: SettledRecoveryResultWriter,
  customAuthorityStoreProvided = false,
) {
  let revision = initialRevision;
  let hasWritten = initialRevision !== undefined;
  let writeChain = Promise.resolve();
  const write = (
    update: Parameters<typeof recordListenerWork>[1],
    phase: ListenerStateWritePhase,
    options: { shouldContinue?: () => boolean } = {},
  ) => {
    const operation = writeChain.then(async () => {
      const expectedRevision = hasWritten ? (revision ?? null) : undefined;
      const next = await (writer
        ? writer(runtime, update, phase, expectedRevision, recoveryLineageId)
        : recordListenerWorkRetriably(
            runtime,
            update,
            phase,
            expectedRevision,
            recoveryLineageId,
            options,
          ));
      hasWritten = true;
      if (typeof next === "string") {
        if (writer && !customAuthorityStoreProvided) {
          throw new Error(
            "Custom recovery authority token requires matching authority store",
          );
        }
        revision = next;
      }
    });
    writeChain = operation.catch(() => {});
    return operation;
  };
  return {
    write,
    checkpointSettledResult(result: ApprovalResult) {
      const operation = writeChain.then(async () => {
        if (!recoveryLineageId) {
          throw new Error("Missing recovery lineage for exact result commit");
        }
        if (settledResultWriter) {
          if (!customAuthorityStoreProvided) {
            throw new Error(
              "Custom recovery authority token requires matching authority store",
            );
          }
          const next = await settledResultWriter(
            runtime,
            recoveryLineageId,
            result,
          );
          hasWritten = true;
          revision = next.revision;
          return next.independentSuccessor;
        }
        if (writer) {
          throw new Error(
            "Custom recovery evidence writer requires exact-result merge capability",
          );
        }
        const store = createInterruptedTurnStore();
        const next = await mergeSettledRecoveryResultRetriably(store, {
          agentId: runtime.agentId ?? "",
          conversationId: runtime.conversationId,
          lineageId: recoveryLineageId,
          result,
        });
        hasWritten = true;
        revision = next.revision;
        return next.independentSuccessor;
      });
      writeChain = operation.then(
        () => {},
        () => {},
      );
      return operation;
    },
    checkpointOwnership(
      ownership: ReturnType<typeof createTurnDurabilityOwnership>,
      actingUserId?: string,
    ) {
      return write(
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
