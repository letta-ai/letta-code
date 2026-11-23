import type { createInterruptedTurnStore } from "./interrupted-turn-record";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";

export function retireReadyTeleportRecord(
  store: ReturnType<typeof createInterruptedTurnStore>,
  record: InterruptedTurnRecord,
): boolean {
  try {
    if (record.teleport?.preserveSuccessorWork) {
      return Boolean(
        store.write(
          { ...record, teleportId: undefined, teleport: undefined },
          record.revision,
        ),
      );
    }
    return store.remove(
      record.agentId,
      record.conversationId,
      record.revision ?? null,
    );
  } catch {
    return false;
  }
}
