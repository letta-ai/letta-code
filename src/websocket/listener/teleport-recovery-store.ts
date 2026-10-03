import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getServerUrl } from "@/backend/api/server-url";
import type { TeleportReadyMessage } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";

export type TeleportRecoveryRecord = {
  teleportId: string;
  agentId: string;
  conversationId: string;
  sourceDeviceId: string;
  sourceSessionId: string;
  disposition: "yielded" | "rejected";
  phase: "preparing" | "source_stopped" | "ready";
  readiness: Pick<
    TeleportReadyMessage,
    | "client_preferences"
    | "success"
    | "active_turn"
    | "mode"
    | "continuation"
    | "error"
  >;
  recordedAt: number;
  recoveryAcceptedAt?: number;
};

// Cloud Teleport records currently expire after one hour. Retain local proof
// for a full day so delayed retries remain safe, while bounding disk growth.
const TELEPORT_RECOVERY_RETENTION_MS = 24 * 60 * 60_000;
const TELEPORT_RECOVERY_PRUNE_INTERVAL_MS = 60 * 60_000;
const TELEPORT_RECOVERY_TEMP_RETENTION_MS = 60 * 60_000;
const TELEPORT_RECOVERY_MAX_BYTES = 1024 * 1024;
const lastPrunedAtByDirectory = new Map<string, number>();

export function canonicalizeTeleportRecoveryServerUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

export function resolveTeleportRecoveryDirectory(
  root: string,
  serverUrl: string,
): string {
  return join(
    root,
    createHash("sha256")
      .update(canonicalizeTeleportRecoveryServerUrl(serverUrl))
      .digest("hex")
      .slice(0, 24),
    "teleport-recovery",
  );
}

function defaultDirectory(): string {
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL || LETTA_CLOUD_API_URL;
  }
  const root =
    process.env.LETTA_LISTENER_STATE_DIR ||
    join(process.env.HOME || homedir(), ".letta", "listener-state");
  return resolveTeleportRecoveryDirectory(root, serverUrl);
}

function recordName(teleportId: string): string {
  return `${createHash("sha256").update(teleportId).digest("hex")}.json`;
}

function isValidReadiness(value: TeleportRecoveryRecord["readiness"]): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    typeof value.success === "boolean" &&
    typeof value.active_turn === "boolean" &&
    !!value.client_preferences &&
    typeof value.client_preferences === "object" &&
    !Array.isArray(value.client_preferences) &&
    (value.mode === undefined ||
      value.mode === "standard" ||
      value.mode === "acceptEdits" ||
      value.mode === "unrestricted" ||
      value.mode === "strict") &&
    (value.error === undefined || typeof value.error === "string") &&
    (value.continuation === undefined ||
      (!!value.continuation && Array.isArray(value.continuation.approvals)))
  );
}

function syncDirectoryMetadata(directory: string): void {
  // Node cannot portably open a directory handle on Windows. A flushed file
  // plus atomic rename is the strongest available contract there; POSIX
  // directory-sync failures fail the readiness write closed.
  if (process.platform === "win32") return;
  const descriptor = openSync(directory, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function ensureDirectory(
  directory: string,
  syncDirectory: (path: string) => void,
): void {
  const missing: string[] = [];
  for (let path = directory; !existsSync(path); path = dirname(path)) {
    missing.push(path);
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const path of missing.reverse()) syncDirectory(dirname(path));
}

function isExpired(
  recordedAt: number,
  modifiedAt: number,
  now: number,
): boolean {
  if (modifiedAt > now || now - modifiedAt <= TELEPORT_RECOVERY_RETENTION_MS) {
    return false;
  }
  return (
    (recordedAt <= now && now - recordedAt > TELEPORT_RECOVERY_RETENTION_MS) ||
    recordedAt > now + TELEPORT_RECOVERY_RETENTION_MS
  );
}

function pruneExpiredRecords(directory: string, now = Date.now()): void {
  const lastPrunedAt = lastPrunedAtByDirectory.get(directory) ?? 0;
  if (
    now >= lastPrunedAt &&
    now - lastPrunedAt < TELEPORT_RECOVERY_PRUNE_INTERVAL_MS
  ) {
    return;
  }
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    const file = join(directory, name);
    const stats = statSync(file);
    if (name.endsWith(".tmp")) {
      if (
        stats.mtimeMs <= now &&
        now - stats.mtimeMs > TELEPORT_RECOVERY_TEMP_RETENTION_MS
      ) {
        rmSync(file, { force: true });
      }
      continue;
    }
    if (!name.endsWith(".json")) continue;
    if (stats.size > TELEPORT_RECOVERY_MAX_BYTES) {
      if (
        stats.mtimeMs <= now &&
        now - stats.mtimeMs > TELEPORT_RECOVERY_RETENTION_MS
      ) {
        rmSync(file, { force: true });
      }
      debugWarn(
        "recovery",
        "Ignoring oversized Teleport recovery record",
        file,
      );
      continue;
    }
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        recordedAt?: unknown;
      };
      if (
        typeof value.recordedAt !== "number" ||
        isExpired(value.recordedAt, stats.mtimeMs, now)
      ) {
        rmSync(file, { force: true });
      }
    } catch {
      rmSync(file, { force: true });
    }
  }
  lastPrunedAtByDirectory.set(directory, now);
}

/**
 * Durable source-side Teleport proof and recovery admission ledger.
 *
 * Writes use fsync + atomic rename, matching the interrupted-turn store. Records
 * outlive Cloud's one-hour record lifetime and newer Teleports, while lazy
 * twenty-four-hour pruning bounds disk growth.
 */
export function createTeleportRecoveryStore(
  directory = defaultDirectory(),
  options: { syncDirectory?: (path: string) => void } = {},
) {
  const syncDirectory = options.syncDirectory ?? syncDirectoryMetadata;
  const path = (teleportId: string) => join(directory, recordName(teleportId));

  return {
    read(teleportId: string): TeleportRecoveryRecord | null {
      const file = path(teleportId);
      try {
        const stats = statSync(file);
        if (stats.size > TELEPORT_RECOVERY_MAX_BYTES) {
          throw new Error("Oversized Teleport recovery record");
        }
        const value = JSON.parse(
          readFileSync(file, "utf8"),
        ) as TeleportRecoveryRecord;
        if (
          !value ||
          value.teleportId !== teleportId ||
          typeof value.agentId !== "string" ||
          typeof value.conversationId !== "string" ||
          typeof value.sourceDeviceId !== "string" ||
          typeof value.sourceSessionId !== "string" ||
          (value.disposition !== "yielded" &&
            value.disposition !== "rejected") ||
          (value.phase !== "preparing" &&
            value.phase !== "source_stopped" &&
            value.phase !== "ready") ||
          !isValidReadiness(value.readiness) ||
          value.readiness.success !== (value.disposition === "yielded") ||
          !Number.isFinite(value.recordedAt) ||
          (value.recoveryAcceptedAt !== undefined &&
            !Number.isFinite(value.recoveryAcceptedAt))
        ) {
          throw new Error("Invalid Teleport recovery record");
        }
        if (isExpired(value.recordedAt, stats.mtimeMs, Date.now())) {
          rmSync(file, { force: true });
          return null;
        }
        return value;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          debugWarn(
            "recovery",
            "Ignoring unreadable Teleport recovery record",
            file,
          );
        }
        return null;
      }
    },

    write(record: TeleportRecoveryRecord): void {
      const serialized = JSON.stringify(record);
      if (Buffer.byteLength(serialized) > TELEPORT_RECOVERY_MAX_BYTES) {
        throw new Error("Teleport recovery record exceeds the size limit");
      }
      ensureDirectory(directory, syncDirectory);
      pruneExpiredRecords(directory);
      const destination = path(record.teleportId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, serialized, {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
        syncDirectory(directory);
      } finally {
        rmSync(temporary, { force: true });
      }
    },

    remove(teleportId: string): void {
      rmSync(path(teleportId), { force: true });
      if (existsSync(directory)) syncDirectory(directory);
    },
  };
}

export type TeleportRecoveryStore = ReturnType<
  typeof createTeleportRecoveryStore
>;
