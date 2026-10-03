import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { getServerUrl } from "@/backend/api/server-url";
import type { TeleportContinuation } from "@/types/protocol_v2";
import { debugWarn } from "@/utils/debug";

export type TeleportRecoveryRecord = {
  teleportId: string;
  agentId: string;
  conversationId: string;
  sourceConnectionId: string;
  disposition: "yielded" | "rejected";
  recordedAt: number;
  error?: string;
  continuation?: TeleportContinuation;
  recoveryAcceptedAt?: number;
};

// Cloud Teleport records currently expire after one hour. Retain local proof
// for a full day so delayed retries remain safe, while bounding disk growth.
const TELEPORT_RECOVERY_RETENTION_MS = 24 * 60 * 60_000;
const TELEPORT_RECOVERY_PRUNE_INTERVAL_MS = 60 * 60_000;
const lastPrunedAtByDirectory = new Map<string, number>();

function defaultDirectory(): string {
  if (process.env.LETTA_LISTENER_STATE_DIR) {
    return join(process.env.LETTA_LISTENER_STATE_DIR, "teleport-recovery");
  }
  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL || LETTA_CLOUD_API_URL;
  }
  return join(
    process.env.HOME || homedir(),
    ".letta",
    "listener-state",
    createHash("sha256").update(serverUrl).digest("hex").slice(0, 24),
    "teleport-recovery",
  );
}

function recordName(teleportId: string): string {
  return `${createHash("sha256").update(teleportId).digest("hex")}.json`;
}

function pruneExpiredRecords(directory: string, now = Date.now()): void {
  const lastPrunedAt = lastPrunedAtByDirectory.get(directory) ?? 0;
  if (now - lastPrunedAt < TELEPORT_RECOVERY_PRUNE_INTERVAL_MS) return;
  lastPrunedAtByDirectory.set(directory, now);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(directory, name);
    try {
      const value = JSON.parse(readFileSync(file, "utf8")) as {
        recordedAt?: unknown;
      };
      if (
        typeof value.recordedAt !== "number" ||
        value.recordedAt < now - TELEPORT_RECOVERY_RETENTION_MS
      ) {
        rmSync(file, { force: true });
      }
    } catch {
      rmSync(file, { force: true });
    }
  }
}

/**
 * Durable source-side Teleport proof and recovery admission ledger.
 *
 * Writes use fsync + atomic rename, matching the interrupted-turn store. Records
 * outlive Cloud's one-hour record lifetime and newer Teleports, while lazy
 * twenty-four-hour pruning bounds disk growth.
 */
export function createTeleportRecoveryStore(directory = defaultDirectory()) {
  const path = (teleportId: string) => join(directory, recordName(teleportId));

  return {
    read(teleportId: string): TeleportRecoveryRecord | null {
      const file = path(teleportId);
      try {
        const value = JSON.parse(
          readFileSync(file, "utf8"),
        ) as TeleportRecoveryRecord;
        if (
          !value ||
          value.teleportId !== teleportId ||
          typeof value.agentId !== "string" ||
          typeof value.conversationId !== "string" ||
          typeof value.sourceConnectionId !== "string" ||
          (value.disposition !== "yielded" &&
            value.disposition !== "rejected") ||
          !Number.isFinite(value.recordedAt) ||
          (value.error !== undefined && typeof value.error !== "string") ||
          (value.continuation !== undefined &&
            (!value.continuation ||
              !Array.isArray(value.continuation.approvals))) ||
          (value.recoveryAcceptedAt !== undefined &&
            !Number.isFinite(value.recoveryAcceptedAt))
        ) {
          throw new Error("Invalid Teleport recovery record");
        }
        if (value.recordedAt < Date.now() - TELEPORT_RECOVERY_RETENTION_MS) {
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
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      pruneExpiredRecords(directory);
      const destination = path(record.teleportId);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(record), {
          mode: 0o600,
          flush: true,
        });
        renameSync(temporary, destination);
      } finally {
        rmSync(temporary, { force: true });
      }
    },
  };
}

export type TeleportRecoveryStore = ReturnType<
  typeof createTeleportRecoveryStore
>;
