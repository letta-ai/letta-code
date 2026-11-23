import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getServerUrl } from "@/backend/api/server-url";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import { fsyncDirectory } from "@/websocket/listener/durable-file-lock";

export type McpOriginatorAuthorityState = "live" | "headerless" | "terminal";

export type McpOriginatorRetirementState = Exclude<
  McpOriginatorAuthorityState,
  "live"
>;

export type AuthorityRecord = {
  floor?: number;
  state: McpOriginatorAuthorityState;
  retiringTo?: McpOriginatorRetirementState;
  updatedAtMs: number;
};

export function isValidGeneration(generation: unknown): generation is number {
  return (
    typeof generation === "number" &&
    Number.isSafeInteger(generation) &&
    generation >= 0
  );
}

const UPDATED_AT_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export function isValidUpdatedAtMs(
  updatedAtMs: unknown,
  nowMs: number,
): updatedAtMs is number {
  return (
    typeof updatedAtMs === "number" &&
    Number.isSafeInteger(updatedAtMs) &&
    updatedAtMs >= 0 &&
    updatedAtMs <= nowMs + UPDATED_AT_FUTURE_SKEW_MS
  );
}

type AuthorityFile = {
  version: 1;
  records: Record<string, AuthorityRecord>;
};

let persistencePathOverride: string | null | undefined;

export function configureAuthorityPersistencePathForTests(
  path: string | null,
): void {
  persistencePathOverride = path;
}

export function authorityPersistentPath(): string | null {
  if (persistencePathOverride !== undefined) return persistencePathOverride;
  if (process.env.NODE_ENV === "test") return null;
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL ?? "uninitialized";
  }
  return authorityPersistentPathForServer(serverUrl);
}

export function authorityPersistentPathForServer(serverUrl: string): string {
  const namespace = createHash("sha256")
    .update(serverUrl)
    .digest("hex")
    .slice(0, 24);
  return join(
    resolveGlobalConfigDir(),
    "state",
    namespace,
    "mcp-originator-authority-v1.json",
  );
}

export const STATE_RANK: Record<McpOriginatorAuthorityState, number> = {
  live: 0,
  headerless: 1,
  terminal: 2,
};

export function mergeRetirementIntents(
  a: McpOriginatorRetirementState | undefined,
  b: McpOriginatorRetirementState | undefined,
): McpOriginatorRetirementState | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return STATE_RANK[a] >= STATE_RANK[b] ? a : b;
}

export function mergeRecords(
  a: AuthorityRecord,
  b: AuthorityRecord | undefined,
): AuthorityRecord {
  if (!b) return a;
  const floor = Math.max(a.floor ?? -1, b.floor ?? -1);
  const state = STATE_RANK[a.state] >= STATE_RANK[b.state] ? a.state : b.state;
  const retiringTo =
    state === "live"
      ? mergeRetirementIntents(a.retiringTo, b.retiringTo)
      : undefined;
  return {
    ...(floor >= 0 ? { floor } : {}),
    state,
    ...(retiringTo !== undefined ? { retiringTo } : {}),
    updatedAtMs: Math.max(a.updatedAtMs, b.updatedAtMs),
  };
}

export function readAuthorityRecords(path: string): {
  records: Map<string, AuthorityRecord>;
  degraded: boolean;
} {
  const records = new Map<string, AuthorityRecord>();
  if (!existsSync(path)) return { records, degraded: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { records?: unknown }).records !== "object" ||
      (parsed as { records?: unknown }).records === null ||
      Array.isArray((parsed as { records?: unknown }).records)
    )
      return { records, degraded: true };
    const nowMs = Date.now();
    for (const [runId, record] of Object.entries(
      (parsed as AuthorityFile).records,
    )) {
      const retiringTo = (record as AuthorityRecord | undefined)?.retiringTo;
      if (
        record &&
        (record.state === "live" ||
          record.state === "headerless" ||
          record.state === "terminal") &&
        (retiringTo === undefined ||
          retiringTo === "headerless" ||
          retiringTo === "terminal") &&
        isValidUpdatedAtMs(record.updatedAtMs, nowMs) &&
        (record.floor === undefined || isValidGeneration(record.floor))
      ) {
        records.set(runId, {
          ...(record.floor !== undefined ? { floor: record.floor } : {}),
          state: record.state,
          ...(record.state === "live" && retiringTo !== undefined
            ? { retiringTo }
            : {}),
          updatedAtMs: record.updatedAtMs,
        });
      } else {
        return { records, degraded: true };
      }
    }
    return { records, degraded: false };
  } catch {
    return { records, degraded: true };
  }
}

export function writeAuthorityRecords(
  path: string,
  records: Map<string, AuthorityRecord>,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const file: AuthorityFile = {
    version: 1,
    records: Object.fromEntries(records),
  };
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(file), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw error;
  }
}
