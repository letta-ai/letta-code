/**
 * Single-instance lock for listener processes.
 *
 * Multiple listener processes for the same (deviceId, connectionName) scope
 * silently contest one environment connection lease on the relay: each
 * re-registration steals the lease from the current holder, dropping its
 * socket mid-turn and orphaning healthy `requires_approval` runs (silent
 * stalls that later surface as stale-approval denials). Confirmed producers
 * are desktop-spawned `letta remote` processes orphaned by an app relaunch
 * and a manual `letta server` running beside a forgotten `letta remote`
 * (LET-9772, LET-10023).
 *
 * Policy: newest wins. A fresh launch expresses user intent, so the claimant
 * terminates the previous same-scope holder and takes the lock. The lock is
 * advisory and local to one host: it cannot see pre-lock listener builds or
 * listeners on other machines (relay-side supersession, LET-10024, covers
 * those).
 *
 * PID-recycling safety: a lock names its owner by pid AND process identity.
 * On POSIX hosts the claimant verifies the pid's current command line still
 * looks like a letta process before terminating it; if the identity check
 * cannot confirm (recycled pid, permission error, win32 without `ps`), the
 * claimant never kills — it only overwrites the lock file.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sleep } from "@/utils/sleep";

export interface ListenerInstanceLockRecord {
  pid: number;
  /** Approximate epoch ms when the owning process started. */
  processStartedAt: number;
  deviceId: string;
  connectionName: string;
  claimedAt: number;
}

export interface ListenerInstanceLockHandle {
  lockPath: string;
  record: ListenerInstanceLockRecord;
}

export interface ClaimListenerInstanceLockResult {
  handle: ListenerInstanceLockHandle;
  /** Set when a previous live holder was found and asked to exit. */
  reapedPid: number | null;
  /** Human-readable notes for session logging (reap outcome, skips). */
  notes: string[];
}

export interface ListenerInstanceLockDependencies {
  isProcessAlive: (pid: number) => boolean;
  /** Returns the command line for a pid, or null when unavailable. */
  getProcessCommand: (pid: number) => string | null;
  terminateProcess: (pid: number, signal: NodeJS.Signals) => void;
  now: () => number;
}

/** How long to wait for a SIGTERMed holder to exit before escalating. */
const REAP_SIGTERM_WAIT_MS = 5_000;
/** How long to wait after SIGKILL before giving up on the reap. */
const REAP_SIGKILL_WAIT_MS = 2_000;
const REAP_POLL_MS = 100;

const LOCK_DIR = path.join(homedir(), ".letta", "listeners");

let activeHandle: ListenerInstanceLockHandle | null = null;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only result that proves the process is gone. Permission
    // failures and unfamiliar platform errors must fail safe (treat alive).
    return !hasErrorCode(error, "ESRCH");
  }
}

function defaultGetProcessCommand(pid: number): string | null {
  if (process.platform === "win32") {
    return null;
  }
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf-8",
      timeout: 2_000,
    });
    if (result.status !== 0) {
      return null;
    }
    const command = result.stdout.trim();
    return command.length > 0 ? command : null;
  } catch {
    return null;
  }
}

function defaultTerminateProcess(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

const DEFAULT_DEPENDENCIES: ListenerInstanceLockDependencies = {
  isProcessAlive: defaultIsProcessAlive,
  getProcessCommand: defaultGetProcessCommand,
  terminateProcess: defaultTerminateProcess,
  now: () => Date.now(),
};

/**
 * Marker used to confirm a lock's pid still belongs to a letta process
 * before terminating it. Listener processes run as `letta.js remote ...`,
 * `letta remote ...`, `letta server ...`, or `bun run src/index.ts remote`
 * in dev — all contain "letta" in the command line.
 */
export function commandLooksLikeLettaProcess(command: string): boolean {
  return command.toLowerCase().includes("letta");
}

export function getListenerInstanceLockPath(
  deviceId: string,
  connectionName: string,
  lockDir: string = LOCK_DIR,
): string {
  const digest = createHash("sha256")
    .update(`${deviceId}\n${connectionName}`)
    .digest("hex")
    .slice(0, 16);
  const slug =
    connectionName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "listener";
  return path.join(lockDir, `${slug}-${digest}.lock`);
}

export function approximateProcessStartedAt(now: number = Date.now()): number {
  return Math.round(now - process.uptime() * 1000);
}

function parseLockRecord(raw: string): ListenerInstanceLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ListenerInstanceLockRecord>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.deviceId !== "string" ||
      typeof parsed.connectionName !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      processStartedAt:
        typeof parsed.processStartedAt === "number"
          ? parsed.processStartedAt
          : 0,
      deviceId: parsed.deviceId,
      connectionName: parsed.connectionName,
      claimedAt: typeof parsed.claimedAt === "number" ? parsed.claimedAt : 0,
    };
  } catch {
    return null;
  }
}

async function readLockRecord(
  lockPath: string,
): Promise<ListenerInstanceLockRecord | null> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf-8");
  } catch {
    return null;
  }
  return parseLockRecord(raw);
}

async function writeLockRecordAtomic(
  lockPath: string,
  record: ListenerInstanceLockRecord,
): Promise<void> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  const tmpPath = path.join(
    path.dirname(lockPath),
    `.${path.basename(lockPath)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(tmpPath, JSON.stringify(record), "utf-8");
    await rename(tmpPath, lockPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
  deps: ListenerInstanceLockDependencies,
): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  while (deps.now() < deadline) {
    if (!deps.isProcessAlive(pid)) {
      return true;
    }
    await sleep(REAP_POLL_MS);
  }
  return !deps.isProcessAlive(pid);
}

/**
 * Terminate a verified previous holder: SIGTERM (graceful — its shutdown
 * handler reaps child processes and releases its lock), escalate to SIGKILL
 * if it does not exit in time.
 */
async function reapPreviousHolder(
  record: ListenerInstanceLockRecord,
  deps: ListenerInstanceLockDependencies,
  notes: string[],
): Promise<void> {
  try {
    deps.terminateProcess(record.pid, "SIGTERM");
  } catch (error) {
    if (hasErrorCode(error, "ESRCH")) {
      return;
    }
    notes.push(
      `SIGTERM to previous listener pid ${record.pid} failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return;
  }

  if (await waitForProcessExit(record.pid, REAP_SIGTERM_WAIT_MS, deps)) {
    notes.push(
      `Terminated previous listener (pid ${record.pid}) for this environment`,
    );
    return;
  }

  try {
    deps.terminateProcess(record.pid, "SIGKILL");
  } catch {
    // Exited between the wait and the escalation.
  }
  if (await waitForProcessExit(record.pid, REAP_SIGKILL_WAIT_MS, deps)) {
    notes.push(
      `Force-killed unresponsive previous listener (pid ${record.pid})`,
    );
    return;
  }
  notes.push(
    `Previous listener (pid ${record.pid}) did not exit; taking over the lock anyway`,
  );
}

/**
 * Claim the single-instance lock for a (deviceId, connectionName) scope.
 *
 * Newest wins: a live, identity-verified previous holder is terminated.
 * The claim itself never fails the caller — worst case it overwrites the
 * lock file and lets relay-side supersession settle any survivor.
 */
export async function claimListenerInstanceLock(params: {
  deviceId: string;
  connectionName: string;
  lockDir?: string;
  dependencies?: Partial<ListenerInstanceLockDependencies>;
}): Promise<ClaimListenerInstanceLockResult> {
  const deps: ListenerInstanceLockDependencies = {
    ...DEFAULT_DEPENDENCIES,
    ...params.dependencies,
  };
  const lockPath = getListenerInstanceLockPath(
    params.deviceId,
    params.connectionName,
    params.lockDir,
  );
  const notes: string[] = [];
  let reapedPid: number | null = null;

  const existing = await readLockRecord(lockPath);
  if (existing && existing.pid !== process.pid) {
    if (!deps.isProcessAlive(existing.pid)) {
      notes.push(`Reclaimed stale listener lock from dead pid ${existing.pid}`);
    } else {
      const command = deps.getProcessCommand(existing.pid);
      if (command === null) {
        // Identity unverifiable (recycled pid already exited, permission
        // error, or platform without `ps`). Never kill blind — overwrite the
        // lock and let relay supersession settle any true survivor.
        notes.push(
          `Previous listener lock held by pid ${existing.pid} but identity is unverifiable; taking over without terminating`,
        );
      } else if (!commandLooksLikeLettaProcess(command)) {
        notes.push(
          `Previous listener lock pid ${existing.pid} was recycled by another program; taking over without terminating`,
        );
      } else {
        reapedPid = existing.pid;
        await reapPreviousHolder(existing, deps, notes);
      }
    }
  }

  const record: ListenerInstanceLockRecord = {
    pid: process.pid,
    processStartedAt: approximateProcessStartedAt(deps.now()),
    deviceId: params.deviceId,
    connectionName: params.connectionName,
    claimedAt: deps.now(),
  };
  await writeLockRecordAtomic(lockPath, record);

  const handle: ListenerInstanceLockHandle = { lockPath, record };
  activeHandle = handle;
  return { handle, reapedPid, notes };
}

/**
 * Release the active lock if this process still owns it. Sync so it is
 * usable from shutdown signal handlers.
 */
export function releaseListenerInstanceLockSync(): void {
  const handle = activeHandle;
  activeHandle = null;
  if (!handle) {
    return;
  }
  try {
    const current = parseLockRecord(readFileSync(handle.lockPath, "utf-8"));
    if (!current || current.pid !== process.pid) {
      // A newer claimant owns the file now — leave it alone.
      return;
    }
    rmSync(handle.lockPath, { force: true });
  } catch {
    // Already gone or unreadable — nothing to release.
  }
}

/** Test-only: reset module-level state. */
export function __resetListenerInstanceLockForTests(): void {
  activeHandle = null;
}

/** Ensure the lock directory exists (used by tests and startup). */
export function ensureListenerLockDirSync(lockDir: string = LOCK_DIR): void {
  try {
    mkdirSync(lockDir, { recursive: true });
  } catch {
    // Creation failures surface later as claim errors.
  }
}
