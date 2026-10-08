import type { InterruptedTurnRecord } from "./interrupted-turn-types";

type RecoverySnapshot = {
  record: InterruptedTurnRecord;
  revisionToken: string;
};

export function createRecoveryAuthorityGuard(dependencies: {
  path: (agentId: string, conversationId: string) => string;
  acquire: (destination: string) => () => void;
  exists: (destination: string) => boolean;
  readRecord: (destination: string) => InterruptedTurnRecord | null;
  ensureSidecar: (current: InterruptedTurnRecord) => void;
  snapshotSidecar: (current: InterruptedTurnRecord) => RecoverySnapshot | null;
}) {
  const readLocked = (
    agentId: string,
    conversationId: string,
    lineageId: string,
  ): RecoverySnapshot | null => {
    const destination = dependencies.path(agentId, conversationId);
    const current = dependencies.readRecord(destination);
    if (!current && dependencies.exists(destination)) {
      throw new Error("Interrupted-turn authority is unreadable");
    }
    if (current?.recoveryClaimCompletion?.lineageId !== lineageId) return null;
    if (current.recoveryClaimCompletion.independentSuccessor !== true) {
      return current.revision
        ? { record: current, revisionToken: current.revision }
        : null;
    }
    dependencies.ensureSidecar(current);
    return dependencies.snapshotSidecar(current);
  };
  return {
    readSnapshot(
      agentId: string,
      conversationId: string,
      lineageId: string,
    ): RecoverySnapshot | null {
      const destination = dependencies.path(agentId, conversationId);
      const release = dependencies.acquire(destination);
      try {
        return readLocked(agentId, conversationId, lineageId);
      } finally {
        release();
      }
    },
    withAuthority(params: {
      agentId: string;
      conversationId: string;
      lineageId: string;
      expectedRevision: string;
      action: () => boolean;
    }): boolean {
      const destination = dependencies.path(
        params.agentId,
        params.conversationId,
      );
      const release = dependencies.acquire(destination);
      try {
        const snapshot = readLocked(
          params.agentId,
          params.conversationId,
          params.lineageId,
        );
        return (
          snapshot?.revisionToken === params.expectedRevision && params.action()
        );
      } finally {
        release();
      }
    },
  };
}
