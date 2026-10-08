import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import type { InputIdentity } from "./types";

export type InterruptedTurnInputOwnership = {
  agentId: string;
  conversationId: string;
  durableInputIdentities: InputIdentity[];
  quarantined: boolean;
};

export type InterruptedTurnMainSnapshot = {
  records: InterruptedTurnRecord[];
  unreadableScopes: Array<{ agentId: string; conversationId: string }>;
};

function decodeMainFilenameScopes(
  file: string,
): Array<{ agentId: string; conversationId: string }> {
  if (!file.endsWith(".json")) return [];
  const stem = file.slice(0, -".json".length);
  const scopes: Array<{ agentId: string; conversationId: string }> = [];
  for (
    let index = stem.indexOf("_");
    index >= 0;
    index = stem.indexOf("_", index + 1)
  ) {
    try {
      const agentId = decodeURIComponent(stem.slice(0, index));
      const conversationId = decodeURIComponent(stem.slice(index + 1));
      if (
        agentId &&
        conversationId &&
        `${encodeURIComponent(agentId)}_${encodeURIComponent(conversationId)}` ===
          stem
      ) {
        scopes.push({ agentId, conversationId });
      }
    } catch {}
  }
  return scopes;
}

export function listInterruptedTurnMainSnapshot(
  directory: string,
  readRecord: (file: string) => InterruptedTurnRecord | null,
): InterruptedTurnMainSnapshot {
  try {
    const records: InterruptedTurnRecord[] = [];
    const unreadableScopes = new Map<
      string,
      { agentId: string; conversationId: string }
    >();
    for (const file of readdirSync(directory).filter((entry) =>
      entry.endsWith(".json"),
    )) {
      const record = readRecord(join(directory, file));
      if (record) {
        records.push(record);
        continue;
      }
      for (const scope of decodeMainFilenameScopes(file)) {
        unreadableScopes.set(
          JSON.stringify([scope.agentId, scope.conversationId]),
          scope,
        );
      }
    }
    return { records, unreadableScopes: [...unreadableScopes.values()] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], unreadableScopes: [] };
    }
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
  unreadableMainScopes: Array<{ agentId: string; conversationId: string }> = [],
): InterruptedTurnInputOwnership[] {
  const ownership = collectInterruptedTurnInputOwnership(records, readMainView);
  const byScope = new Map(
    ownership.map((entry) => [
      JSON.stringify([entry.agentId, entry.conversationId]),
      entry,
    ]),
  );
  for (const scope of unreadableMainScopes) {
    const scopeKey = JSON.stringify([scope.agentId, scope.conversationId]);
    byScope.set(scopeKey, {
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      durableInputIdentities: [],
      quarantined: true,
    });
  }
  for (const sidecar of sidecars) {
    const scopeKey = JSON.stringify([sidecar.agentId, sidecar.conversationId]);
    if (!mainExists(sidecar.agentId, sidecar.conversationId)) continue;
    const entry = byScope.get(scopeKey) ?? {
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
    byScope.set(scopeKey, entry);
  }
  return [...byScope.values()];
}

import { readdirSync } from "node:fs";
import { join } from "node:path";
