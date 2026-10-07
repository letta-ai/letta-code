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

export function collectInterruptedTurnInputOwnershipWithSidecars(
  records: InterruptedTurnRecord[],
  readMainView: (record: InterruptedTurnRecord) => InterruptedTurnRecord,
  sidecars: Array<{
    agentId: string;
    conversationId: string;
    durableInputIdentities?: InputIdentity[];
  }>,
  mainExists: (agentId: string, conversationId: string) => boolean,
): InterruptedTurnInputOwnership[] {
  const ownership = collectInterruptedTurnInputOwnership(records, readMainView);
  const readableScopes = new Set(
    records.map((record) =>
      JSON.stringify([record.agentId, record.conversationId]),
    ),
  );
  const corruptScopes = new Map<string, InterruptedTurnInputOwnership>();
  for (const sidecar of sidecars) {
    const scopeKey = JSON.stringify([sidecar.agentId, sidecar.conversationId]);
    if (
      readableScopes.has(scopeKey) ||
      !mainExists(sidecar.agentId, sidecar.conversationId)
    ) {
      continue;
    }
    const entry = corruptScopes.get(scopeKey) ?? {
      agentId: sidecar.agentId,
      conversationId: sidecar.conversationId,
      durableInputIdentities: [],
      quarantined: true,
    };
    const identities = new Map(
      entry.durableInputIdentities.map((identity) => [
        `${identity.domain}\0${identity.id}`,
        identity,
      ]),
    );
    for (const identity of sidecar.durableInputIdentities ?? []) {
      identities.set(`${identity.domain}\0${identity.id}`, identity);
    }
    entry.durableInputIdentities = [...identities.values()];
    corruptScopes.set(scopeKey, entry);
  }
  return [...ownership, ...corruptScopes.values()];
}

import { readdirSync } from "node:fs";
import { join } from "node:path";
