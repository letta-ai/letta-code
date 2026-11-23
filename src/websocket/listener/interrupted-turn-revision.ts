import { randomUUID } from "node:crypto";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";

export function stampInterruptedTurnRevision(
  record: InterruptedTurnRecord,
): InterruptedTurnRecord {
  const revision = randomUUID();
  return {
    ...record,
    revision,
    ...(record.teleport
      ? {
          teleport: {
            ...record.teleport,
            intentRevision: record.teleport.intentRevision ?? revision,
            ...(record.teleport.terminalAuthority
              ? {
                  terminalAuthority: {
                    ...record.teleport.terminalAuthority,
                    interruptedRevision:
                      record.teleport.terminalAuthority.interruptedRevision ||
                      revision,
                    authorityRevision:
                      record.teleport.terminalAuthority.authorityRevision ||
                      revision,
                  },
                }
              : {}),
            readyRevision: record.teleport.ready
              ? (record.teleport.readyRevision ?? revision)
              : record.teleport.readyRevision,
          },
        }
      : {}),
  };
}
