import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveGlobalStateDir } from "@/utils/settings-path";
import { captureProcessIdentity, isProcessAlive } from "./process-identity";

export interface ListenerCronLease {
  id: string;
  token: string;
  pid: number;
  started_at: string;
  process_start_ticks: string | null;
  boot_id: string | null;
}

let currentListenerId: string | undefined;

export function configureListenerCronOwner(
  deviceId: string,
  name: string,
): string {
  currentListenerId = createHash("sha256")
    .update(JSON.stringify([deviceId, name]))
    .digest("hex");
  return currentListenerId;
}

export function getListenerCronOwner(): string | undefined {
  return currentListenerId;
}

export function clearListenerCronOwner(): void {
  currentListenerId = undefined;
}

function leasePath(id: string): string {
  return join(resolveGlobalStateDir(), "cron-listeners", `${id}.json`);
}

function readLease(id: string): ListenerCronLease | null {
  const file = leasePath(id);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ListenerCronLease;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Caller holds crons.lock, shared with task writes and the legacy lease. */
export function claimListenerCronLease(id: string): ListenerCronLease {
  const previous = readLease(id);
  if (previous && isProcessAlive(previous.pid, previous)) {
    throw new Error(`Listener scheduler lease held by PID ${previous.pid}`);
  }
  const lease: ListenerCronLease = {
    id,
    token: randomUUID(),
    pid: process.pid,
    started_at: new Date().toISOString(),
    ...captureProcessIdentity(process.pid),
  };
  mkdirSync(join(resolveGlobalStateDir(), "cron-listeners"), {
    recursive: true,
  });
  const file = leasePath(id);
  writeFileSync(`${file}.tmp`, JSON.stringify(lease), { flush: true });
  renameSync(`${file}.tmp`, file);
  return lease;
}

export function hasLiveListenerCronLease(id: string | undefined): boolean {
  const lease = id ? readLease(id) : null;
  return Boolean(lease && isProcessAlive(lease.pid, lease));
}

export function verifyListenerCronLease(lease: ListenerCronLease): boolean {
  const owner = readLease(lease.id);
  return owner?.pid === process.pid && owner.token === lease.token;
}

/** Caller holds crons.lock. */
export function releaseListenerCronLease(lease: ListenerCronLease): void {
  if (verifyListenerCronLease(lease)) unlinkSync(leasePath(lease.id));
}
