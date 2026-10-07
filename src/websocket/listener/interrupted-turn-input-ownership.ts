import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import type { InputIdentity } from "./types";

export type InterruptedTurnInputOwnership = {
  agentId: string;
  conversationId: string;
  durableInputIdentities: InputIdentity[];
  quarantined: boolean;
};

export function listRawInterruptedTurnRecords(
  directory: string,
  readRecord: (file: string) => InterruptedTurnRecord | null,
): InterruptedTurnRecord[] {
  try {
    return readdirSync(directory)
      .filter((file) => file.endsWith(".json"))
      .map((file) => readRecord(join(directory, file)))
      .filter((record): record is InterruptedTurnRecord => record !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Build a replay fence from validated main JSON without trusting its sidecar. */
export function collectInterruptedTurnInputOwnership(
  records: InterruptedTurnRecord[],
  readMainView: (record: InterruptedTurnRecord) => InterruptedTurnRecord,
): InterruptedTurnInputOwnership[] {
  return records.map((record) => {
    let quarantined = false;
    try {
      readMainView(record);
    } catch {
      quarantined = true;
    }
    const identities = new Map<string, InputIdentity>();
    for (const identity of [
      ...(record.durableInputIdentities ?? []),
      ...(record.recoveryClaimCompletion?.effectInputIdentities ?? []),
    ]) {
      identities.set(`${identity.domain}\0${identity.id}`, identity);
    }
    return {
      agentId: record.agentId,
      conversationId: record.conversationId,
      durableInputIdentities: [...identities.values()],
      quarantined,
    };
  });
}

import { readdirSync } from "node:fs";
import { join } from "node:path";
