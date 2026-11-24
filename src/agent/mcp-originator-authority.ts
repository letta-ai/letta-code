import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { acquireDurableFileLock } from "@/websocket/listener/durable-file-lock";
import {
  type AuthorityRecord,
  authorityPersistentPath,
  configureAuthorityPersistencePathForTests,
  isValidGeneration,
  type McpOriginatorAuthorityState,
  type McpOriginatorRetirementState,
  mergeRecords,
  mergeRetirementIntents,
  readAuthorityRecords,
  STATE_RANK,
  writeAuthorityRecords,
} from "./mcp-originator-authority-file";

export type {
  McpOriginatorAuthorityState,
  McpOriginatorRetirementState,
} from "./mcp-originator-authority-file";

const AUTHORITY_RECORD_TTL_MS = 2 * 60 * 60 * 1000;

let recordTtlMs = AUTHORITY_RECORD_TTL_MS;

const recordsBySuperRunId = new Map<string, AuthorityRecord>();

function pruneExpired(nowMs: number): boolean {
  let pruned = false;
  for (const [runId, record] of recordsBySuperRunId) {
    if (nowMs - record.updatedAtMs > recordTtlMs) {
      recordsBySuperRunId.delete(runId);
      pruned = true;
    }
  }
  return pruned;
}

function authorityTransaction<T>(
  mutate: (
    records: Map<string, AuthorityRecord>,
    ctx: { degraded: boolean },
  ) => {
    result: T;
    changed: boolean;
  },
): T {
  const path = authorityPersistentPath();
  if (!path) {
    return mutate(recordsBySuperRunId, { degraded: false }).result;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const release = acquireDurableFileLock(path, { waitMs: 2_000 });
  try {
    const { records: disk, degraded } = readAuthorityRecords(path);
    if (!degraded) {
      const memory = new Map(recordsBySuperRunId);
      recordsBySuperRunId.clear();
      for (const [runId, record] of disk) {
        recordsBySuperRunId.set(
          runId,
          mergeRecords(record, memory.get(runId)) ?? record,
        );
      }
      for (const [runId, record] of memory) {
        if (!disk.has(runId)) recordsBySuperRunId.set(runId, record);
      }
      pruneExpired(Date.now());
      resumeDurableRetirementIntents();
    }
    const { result, changed } = mutate(recordsBySuperRunId, { degraded });
    if (changed && !degraded) writeAuthorityRecords(path, recordsBySuperRunId);
    return result;
  } finally {
    release();
  }
}

function mutateDurableFirst(
  label: string,
  mutate: (records: Map<string, AuthorityRecord>) => void,
): boolean {
  if (!authorityPersistentPath()) {
    mutate(recordsBySuperRunId);
    return true;
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const persisted = authorityTransaction((records, ctx) => {
        if (ctx.degraded) return { result: false, changed: false };
        mutate(records);
        return { result: true, changed: true };
      });
      if (persisted) return true;
      console.error(
        `[mcp-originator-authority] durable file is degraded for ${label}; the boundary holds in this process but is NOT durable across restart`,
      );
      mutate(recordsBySuperRunId);
      return false;
    } catch (error) {
      console.error(
        `[mcp-originator-authority] durable write failed for ${label} (attempt ${attempt}/3)`,
        error,
      );
    }
  }
  console.error(
    `[mcp-originator-authority] durable write failed for ${label} after retries; the boundary still holds in this process but is NOT durable across restart`,
  );
  mutate(recordsBySuperRunId);
  return false;
}

const pendingRetirements = new Map<
  string,
  {
    state: McpOriginatorRetirementState;
    generation?: number;
    createdAtMs: number;
  }
>();
let retirementRetryTimer: ReturnType<typeof setTimeout> | undefined;
const retirementRetryIntervalMs = 30_000;
const MAX_RETIREMENT_RETRIES_PER_TICK = 25;

function scheduleRetirementRetry(): void {
  if (pendingRetirements.size === 0) return;
  if (retirementRetryTimer !== undefined) return;
  if (process.env.NODE_ENV === "test") return;
  retirementRetryTimer = setTimeout(() => {
    retirementRetryTimer = undefined;
    retryPendingMcpOriginatorRetirements();
  }, retirementRetryIntervalMs);
  retirementRetryTimer.unref?.();
}

export function retryPendingMcpOriginatorRetirements(): void {
  const nowMs = Date.now();
  let processed = 0;
  for (const [runId, pending] of pendingRetirements) {
    if (nowMs - pending.createdAtMs > recordTtlMs) {
      console.error(
        `[mcp-originator-authority] pending ${pending.state} retirement for ${runId} outlived the ${Math.round(recordTtlMs / 60_000)}-minute record TTL; dropping the retry (any token it fenced is dead at the server-side ceiling)`,
      );
      pendingRetirements.delete(runId);
      continue;
    }
    if (processed >= MAX_RETIREMENT_RETRIES_PER_TICK) {
      continue;
    }
    processed += 1;
    const durable = mutateDurableFirst(
      `retirement retry (${pending.state}) for ${runId}`,
      (records) =>
        touchRecords(records, runId, pending.generation, pending.state, {
          preserveUpdatedAt: true,
        }),
    );
    if (durable) pendingRetirements.delete(runId);
  }
  if (pendingRetirements.size > 0) scheduleRetirementRetry();
}

function persistRetirementIntent(
  runId: string,
  state: McpOriginatorRetirementState,
  generation: number | undefined,
): void {
  const path = authorityPersistentPath();
  if (!path) return;
  try {
    const release = acquireDurableFileLock(path, { waitMs: 2_000 });
    try {
      const { records: disk, degraded } = readAuthorityRecords(path);
      if (degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded for the retirement intent (${state}) for ${runId}; the boundary holds in this process only`,
        );
        return;
      }
      const existing = disk.get(runId);
      if (existing && existing.state !== "live") return;
      const floor =
        generation !== undefined && isValidGeneration(generation)
          ? Math.max(existing?.floor ?? -1, generation)
          : existing?.floor;
      disk.set(runId, {
        ...(floor !== undefined && floor >= 0 ? { floor } : {}),
        state: "live",
        retiringTo:
          mergeRetirementIntents(existing?.retiringTo, state) ?? state,
        updatedAtMs: existing?.updatedAtMs ?? Date.now(),
      });
      writeAuthorityRecords(path, disk);
    } finally {
      release();
    }
  } catch (error) {
    console.error(
      `[mcp-originator-authority] durable retirement intent (${state}) write failed for ${runId}; peers cannot see the boundary until a retry lands the mark`,
      error,
    );
  }
}

function resumeDurableRetirementIntents(): void {
  for (const [runId, record] of recordsBySuperRunId) {
    if (record.state !== "live" || record.retiringTo === undefined) continue;
    const existing = pendingRetirements.get(runId);
    if (existing && existing.createdAtMs <= record.updatedAtMs) continue;
    pendingRetirements.set(runId, {
      state: record.retiringTo,
      ...(record.floor !== undefined ? { generation: record.floor } : {}),
      createdAtMs: Math.min(
        existing?.createdAtMs ?? record.updatedAtMs,
        record.updatedAtMs,
      ),
    });
  }
  scheduleRetirementRetry();
}

function registerPendingRetirement(
  runId: string,
  state: McpOriginatorRetirementState,
  generation: number | undefined,
  durable: boolean,
): void {
  if (durable) {
    const pending = pendingRetirements.get(runId);
    if (pending && STATE_RANK[pending.state] <= STATE_RANK[state]) {
      pendingRetirements.delete(runId);
    }
    return;
  }
  persistRetirementIntent(runId, state, generation);
  const existing = pendingRetirements.get(runId);
  const merged: {
    state: McpOriginatorRetirementState;
    generation?: number;
    createdAtMs: number;
  } = {
    state:
      existing && STATE_RANK[existing.state] > STATE_RANK[state]
        ? existing.state
        : state,
    createdAtMs: existing?.createdAtMs ?? Date.now(),
  };
  const mergedGeneration = generation ?? existing?.generation;
  if (mergedGeneration !== undefined) merged.generation = mergedGeneration;
  pendingRetirements.set(runId, merged);
  scheduleRetirementRetry();
}

export function readPendingMcpOriginatorRetirementsForTests(): ReadonlyMap<
  string,
  {
    state: McpOriginatorRetirementState;
    generation?: number;
    createdAtMs: number;
  }
> {
  return pendingRetirements;
}

function touchRecords(
  records: Map<string, AuthorityRecord>,
  runId: string,
  generation: number | undefined,
  state?: McpOriginatorAuthorityState,
  options?: {
    preserveUpdatedAt?: boolean;
  },
): void {
  const existing = records.get(runId);
  const usableGeneration =
    generation !== undefined && isValidGeneration(generation)
      ? generation
      : undefined;
  const floor =
    usableGeneration === undefined
      ? existing?.floor
      : Math.max(existing?.floor ?? -1, usableGeneration);
  const nextState =
    state === undefined
      ? (existing?.state ?? "live")
      : existing?.state !== undefined &&
          STATE_RANK[existing.state] > STATE_RANK[state]
        ? existing.state
        : state;
  records.set(runId, {
    ...(floor !== undefined ? { floor } : {}),
    state: nextState,
    ...(nextState === "live" && existing?.retiringTo !== undefined
      ? { retiringTo: existing.retiringTo }
      : {}),
    updatedAtMs:
      options?.preserveUpdatedAt === true && existing !== undefined
        ? existing.updatedAtMs
        : Date.now(),
  });
}

export function noteMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): boolean {
  return mutateDurableFirst(`floor bump for ${runId}`, (records) =>
    touchRecords(records, runId, generation),
  );
}

export type McpOriginatorAdmission =
  | { admitted: true }
  | { admitted: false; permanent: boolean };

export function admitMcpOriginatorDelivery(
  runId: string,
  generation: number | undefined,
): McpOriginatorAdmission {
  if (generation !== undefined && !isValidGeneration(generation)) {
    console.error(
      `[mcp-originator-authority] malformed generation for ${runId}; denying admission (fail-closed)`,
    );
    return { admitted: false, permanent: true };
  }
  if (!authorityPersistentPath()) {
    const record = recordsBySuperRunId.get(runId);
    if (record) {
      if (record.state !== "live" || record.retiringTo !== undefined)
        return { admitted: false, permanent: true };
      if (
        record.floor !== undefined &&
        (generation === undefined || generation < record.floor)
      )
        return { admitted: false, permanent: true };
    }
    touchRecords(recordsBySuperRunId, runId, generation);
    return { admitted: true };
  }
  try {
    return authorityTransaction<McpOriginatorAdmission>((records, ctx) => {
      if (ctx.degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded; denying admission for ${runId} (fail-closed, retryable)`,
        );
        return {
          result: { admitted: false, permanent: false },
          changed: false,
        };
      }
      const record = records.get(runId);
      if (record) {
        if (record.state !== "live" || record.retiringTo !== undefined)
          return {
            result: { admitted: false, permanent: true },
            changed: false,
          };
        if (
          record.floor !== undefined &&
          (generation === undefined || generation < record.floor)
        )
          return {
            result: { admitted: false, permanent: true },
            changed: false,
          };
      }
      touchRecords(records, runId, generation);
      return { result: { admitted: true }, changed: true };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] admission transaction failed for ${runId}; denying the delivery (fail-closed, retryable)`,
      error,
    );
    return { admitted: false, permanent: false };
  }
}

export function mcpOriginatorAuthorityPermitsUse(
  runId: string,
  generation: number | undefined,
): boolean {
  if (generation !== undefined && !isValidGeneration(generation)) {
    console.error(
      `[mcp-originator-authority] malformed generation for ${runId}; withdrawing the token (fail-closed)`,
    );
    return false;
  }
  try {
    return authorityTransaction((records, ctx) => {
      if (ctx.degraded) return { result: false, changed: false };
      const record = records.get(runId);
      if (!record) return { result: true, changed: false };
      if (record.state !== "live" || record.retiringTo !== undefined)
        return { result: false, changed: false };
      if (
        record.floor !== undefined &&
        generation !== undefined &&
        generation < record.floor
      )
        return { result: false, changed: false };
      return { result: true, changed: false };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] use check failed for ${runId}; withdrawing the token (fail-closed)`,
      error,
    );
    return false;
  }
}

export function markMcpOriginatorHeaderless(
  runId: string,
  deletedGeneration?: number,
): boolean {
  const durable = mutateDurableFirst(
    `headerless mark for ${runId}`,
    (records) => touchRecords(records, runId, deletedGeneration, "headerless"),
  );
  registerPendingRetirement(runId, "headerless", deletedGeneration, durable);
  return durable;
}

export function markMcpOriginatorTerminal(
  runId: string,
  deletedGeneration?: number,
): boolean {
  const durable = mutateDurableFirst(`terminal mark for ${runId}`, (records) =>
    touchRecords(records, runId, deletedGeneration, "terminal"),
  );
  registerPendingRetirement(runId, "terminal", deletedGeneration, durable);
  return durable;
}

export function mcpOriginatorAuthorityAllows(
  runId: string,
  generation: number | undefined,
): boolean {
  try {
    return authorityTransaction((records, ctx) => {
      if (ctx.degraded) {
        console.error(
          `[mcp-originator-authority] durable file is degraded; denying the delivery for ${runId} (fail-closed)`,
        );
        return { result: false, changed: false };
      }
      const record = records.get(runId);
      let allows = true;
      if (record) {
        if (record.state !== "live" || record.retiringTo !== undefined) {
          allows = false;
        } else if (record.floor !== undefined) {
          if (generation === undefined || generation < record.floor)
            allows = false;
        }
      }
      return { result: allows, changed: false };
    });
  } catch (error) {
    console.error(
      `[mcp-originator-authority] authority read failed for ${runId}; denying the delivery (fail-closed)`,
      error,
    );
    return false;
  }
}

export function configureMcpOriginatorAuthorityPersistenceForTests(
  path: string | null,
): void {
  configureAuthorityPersistencePathForTests(path);
}

export function configureMcpOriginatorAuthorityTtlForTests(
  ttlMs: number | null,
): void {
  recordTtlMs = ttlMs ?? AUTHORITY_RECORD_TTL_MS;
}

export function resetMcpOriginatorAuthority(): void {
  recordsBySuperRunId.clear();
  pendingRetirements.clear();
  recordTtlMs = AUTHORITY_RECORD_TTL_MS;
  if (retirementRetryTimer !== undefined) {
    clearTimeout(retirementRetryTimer);
    retirementRetryTimer = undefined;
  }
}

export function readMcpOriginatorAuthorityForTests(runId: string):
  | {
      floor?: number;
      state: McpOriginatorAuthorityState;
      retiringTo?: McpOriginatorRetirementState;
    }
  | undefined {
  const record = authorityTransaction((records) => ({
    result: records.get(runId),
    changed: false,
  }));
  return record
    ? {
        ...(record.floor !== undefined ? { floor: record.floor } : {}),
        state: record.state,
        ...(record.retiringTo !== undefined
          ? { retiringTo: record.retiringTo }
          : {}),
      }
    : undefined;
}
