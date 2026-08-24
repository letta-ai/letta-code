/**
 * Local single-instance ownership for standalone remote listeners.
 *
 * Two `letta server` processes launched from the same machine currently derive
 * the same listener instance id from their environment name. If both register,
 * they rotate the same Cloud connection lease. This lock stops the second
 * local process before registration. It never signals the incumbent.
 *
 * Desktop-owned children are out of scope: their spawner supplies distinct
 * listener identities and owns their lifecycle.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync } from "node:fs";
import {
  link,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface ManualListenerLockScope {
  serverUrl: string;
  deviceId: string;
  listenerInstanceId: string;
}

export interface ManualListenerLockHandle {
  lockPath: string;
  release: () => Promise<void>;
}

interface ManualListenerLockRecord {
  version: 1;
  pid: number;
  ownerToken: string;
  acquiredAt: string;
  scopeHash: string;
  leaseVersion?: 1;
  processStartTicks?: string | null;
  bootId?: string | null;
  pidNamespace?: string | null;
}

interface ProcessIdentity {
  startTicks: string | null;
  bootId: string | null;
  pidNamespace: string | null;
}

interface ManualListenerLockDeps {
  lockRoot: string;
  processId: number;
  ownerToken: string;
  isProcessAlive: (pid: number) => boolean;
  readProcessIdentity: (pid: number) => ProcessIdentity | null;
  isOwnerHeartbeatFresh: (
    lockPath: string,
    ownerToken: string,
  ) => Promise<boolean>;
  onLeaseLost: () => void;
}

const RECOVERY_MAX_DEPTH = 64;
const HEARTBEAT_INTERVAL_MS = 10_000;
const HEARTBEAT_TIMEOUT_MS = 60_000;

export class ManualListenerAlreadyRunningError extends Error {
  readonly holderPid: number;
  readonly lockPath: string;

  constructor(holderPid: number, lockPath: string) {
    super(`A matching listener is already running (pid ${holderPid}).`);
    this.name = "ManualListenerAlreadyRunningError";
    this.holderPid = holderPid;
    this.lockPath = lockPath;
  }
}

export class ManualListenerLockUnavailableError extends Error {
  readonly lockPath: string;

  constructor(message: string, lockPath: string) {
    super(message);
    this.name = "ManualListenerLockUnavailableError";
    this.lockPath = lockPath;
  }
}

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
    // Only ESRCH proves that the owner is gone. Permission and unfamiliar
    // platform failures stay fail-closed and report the lock as held.
    return !hasErrorCode(error, "ESRCH");
  }
}

function readLinuxProcessIdentity(pid: number): ProcessIdentity | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const endCommand = stat.lastIndexOf(")");
    if (endCommand === -1) return null;

    // /proc/<pid>/stat field #22 is process start time in clock ticks since
    // boot. It distinguishes a reused PID, including PID 1 in a replacement
    // container, from the process that originally wrote the lock.
    const fields = stat
      .slice(endCommand + 2)
      .trim()
      .split(/\s+/);
    const startTicks = fields[19] ?? null;
    if (!startTicks) return null;

    let bootId: string | null = null;
    try {
      bootId =
        readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
    } catch {
      // Process start time is still useful when the kernel boot id is hidden.
    }
    let pidNamespace: string | null = null;
    try {
      pidNamespace = readlinkSync(`/proc/${pid}/ns/pid`) || null;
    } catch {
      // A filesystem heartbeat remains authoritative across PID namespaces.
    }
    return { startTicks, bootId, pidNamespace };
  } catch {
    // Non-Linux platforms retain the existing PID liveness fallback.
    return null;
  }
}

async function isLockOwnerAlive(
  owner: ManualListenerLockRecord,
  lockPath: string,
  deps: ManualListenerLockDeps,
): Promise<boolean> {
  // Legacy records predate filesystem leases. Preserve their fail-closed PID
  // behavior because another live, older container cannot renew a heartbeat.
  if (owner.leaseVersion !== 1) return deps.isProcessAlive(owner.pid);

  const currentIdentity = deps.readProcessIdentity(owner.pid);
  if (
    owner.pidNamespace &&
    currentIdentity?.pidNamespace === owner.pidNamespace
  ) {
    if (!deps.isProcessAlive(owner.pid)) return false;
    if (
      owner.bootId &&
      currentIdentity.bootId &&
      owner.bootId !== currentIdentity.bootId
    ) {
      return false;
    }
    if (
      owner.processStartTicks &&
      currentIdentity.startTicks &&
      owner.processStartTicks !== currentIdentity.startTicks
    ) {
      return false;
    }
    return deps.isOwnerHeartbeatFresh(lockPath, owner.ownerToken);
  }

  // PIDs are namespace-local. A contender can only trust liveness checks when
  // it can prove it shares the owner's namespace; otherwise the filesystem
  // lease is the cross-container source of truth.
  return deps.isOwnerHeartbeatFresh(lockPath, owner.ownerToken);
}

function getOwnerHeartbeatPath(lockPath: string, ownerToken: string): string {
  const ownerHash = createHash("sha256").update(ownerToken).digest("hex");
  return `${lockPath}.owner.${ownerHash}.heartbeat`;
}

async function defaultIsOwnerHeartbeatFresh(
  lockPath: string,
  ownerToken: string,
): Promise<boolean> {
  try {
    const heartbeatStat = await stat(
      getOwnerHeartbeatPath(lockPath, ownerToken),
    );
    return Date.now() - heartbeatStat.mtimeMs <= HEARTBEAT_TIMEOUT_MS;
  } catch (error) {
    // Missing proves the lease is absent. Unknown filesystem failures remain
    // fail-closed so a contender cannot steal ownership during a volume issue.
    return !hasErrorCode(error, "ENOENT");
  }
}

async function createOwnerHeartbeat(
  lockPath: string,
  ownerToken: string,
  ownerContents: string,
  scopeHash: string,
  deps: ManualListenerLockDeps,
  onLeaseLost: () => void,
): Promise<{
  start: () => void;
  stop: () => Promise<void>;
}> {
  const heartbeatPath = getOwnerHeartbeatPath(lockPath, ownerToken);
  const heartbeatFile = await open(heartbeatPath, "wx");
  try {
    await heartbeatFile.writeFile(ownerToken);
  } catch (error) {
    await heartbeatFile.close().catch(() => {});
    await rm(heartbeatPath, { force: true }).catch(() => {});
    throw error;
  }
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let renewal = Promise.resolve();

  const removeHeartbeat = async (): Promise<void> => {
    await heartbeatFile.close().catch(() => {});
    await rm(heartbeatPath, { force: true });
  };

  const loseLease = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    await removeHeartbeat().catch(() => {});
    onLeaseLost();
  };

  const renew = async (): Promise<void> => {
    if (stopped) return;
    try {
      const claim = await acquireRecoveryClaim(
        lockPath,
        ownerContents,
        ownerContents,
        scopeHash,
        deps,
      );
      if (!claim) return;
      try {
        if (!(await defaultIsOwnerHeartbeatFresh(lockPath, ownerToken))) {
          throw new Error("Listener ownership heartbeat expired");
        }
        const lockBeforeRenewal = await readFile(lockPath, "utf-8");
        if (lockBeforeRenewal !== ownerContents) {
          throw new Error(
            "Listener ownership changed before heartbeat renewal",
          );
        }
        if (stopped) return;
        // Renew the already-open inode rather than rewriting by path. If a
        // recoverer unlinks the lease, an in-flight renewal cannot recreate it.
        const renewedAt = new Date();
        await heartbeatFile.utimes(renewedAt, renewedAt);
        const lockAfterRenewal = await readFile(lockPath, "utf-8");
        if (lockAfterRenewal !== ownerContents) {
          throw new Error(
            "Listener ownership changed during heartbeat renewal",
          );
        }
      } finally {
        await claim.release();
      }
    } catch {
      await loseLease();
    }
  };

  return {
    start: () => {
      timer = setInterval(() => {
        renewal = renewal.then(renew);
      }, HEARTBEAT_INTERVAL_MS);
      timer.unref();
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await renewal;
      await removeHeartbeat();
    },
  };
}

function getDefaultLockRoot(): string {
  // The device id used in the registration key is stored under this same
  // HOME-scoped `.letta` directory. An unrelated LETTA_HOME override must not
  // split locks for processes that still share that device identity.
  return path.join(process.env.HOME || homedir(), ".letta");
}

export function normalizeManualListenerServerUrl(serverUrl: string): string {
  const trimmed = serverUrl.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

export function shouldAcquireManualListenerLock(
  spawnerListenerInstanceId: string | null,
  isDesktopSpawn: boolean,
): boolean {
  // Preserve compatibility if this letta-code version is ever bundled by an
  // older Desktop that sets LETTA_DESKTOP_MODE but not the explicit identity
  // added by LET-10085. Desktop must never enter the generic manual guard.
  return spawnerListenerInstanceId === null && !isDesktopSpawn;
}

export function getManualListenerScopeHash(
  scope: ManualListenerLockScope,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeManualListenerServerUrl(scope.serverUrl),
        scope.deviceId,
        scope.listenerInstanceId,
      ]),
    )
    .digest("hex");
}

function parseLockRecord(
  raw: string,
  expectedScopeHash: string,
): ManualListenerLockRecord | null {
  try {
    const parsed = JSON.parse(raw) as Partial<ManualListenerLockRecord>;
    if (
      parsed.version !== 1 ||
      !Number.isSafeInteger(parsed.pid) ||
      (parsed.pid ?? 0) <= 0 ||
      typeof parsed.ownerToken !== "string" ||
      parsed.ownerToken.length === 0 ||
      typeof parsed.acquiredAt !== "string" ||
      (parsed.leaseVersion !== undefined && parsed.leaseVersion !== 1) ||
      (parsed.processStartTicks !== undefined &&
        parsed.processStartTicks !== null &&
        (typeof parsed.processStartTicks !== "string" ||
          parsed.processStartTicks.length === 0)) ||
      (parsed.bootId !== undefined &&
        parsed.bootId !== null &&
        (typeof parsed.bootId !== "string" || parsed.bootId.length === 0)) ||
      (parsed.pidNamespace !== undefined &&
        parsed.pidNamespace !== null &&
        (typeof parsed.pidNamespace !== "string" ||
          parsed.pidNamespace.length === 0)) ||
      parsed.scopeHash !== expectedScopeHash
    ) {
      return null;
    }
    return parsed as ManualListenerLockRecord;
  } catch {
    return null;
  }
}

async function publishInitializedFile(
  targetPath: string,
  contents: string,
): Promise<unknown> {
  const candidatePath = path.join(
    path.dirname(targetPath),
    `.manual-listener-lock-${randomUUID()}.candidate`,
  );
  let publicationError: unknown;
  try {
    await writeFile(candidatePath, contents, { flag: "wx" });
    await link(candidatePath, targetPath);
  } catch (error) {
    publicationError = error;
  }
  await rm(candidatePath, { force: true }).catch(() => {});
  return publicationError;
}

function getRecoveryClaimPath(
  lockPath: string,
  staleContents: string,
  depth: number,
): string {
  const staleHash = createHash("sha256").update(staleContents).digest("hex");
  return `${lockPath}.recover.${staleHash}.${depth}`;
}

async function cleanupRecoveryClaims(
  lockPath: string,
  staleContents: string,
  deepestClaim: number,
): Promise<void> {
  for (let depth = deepestClaim; depth >= 0; depth--) {
    await rm(getRecoveryClaimPath(lockPath, staleContents, depth), {
      force: true,
    }).catch(() => {});
  }
}

async function acquireRecoveryClaim(
  lockPath: string,
  staleContents: string,
  recoveryOwnerContents: string,
  scopeHash: string,
  deps: ManualListenerLockDeps,
): Promise<{ release: () => Promise<void> } | null> {
  for (let depth = 0; depth < RECOVERY_MAX_DEPTH; depth++) {
    const claimPath = getRecoveryClaimPath(lockPath, staleContents, depth);
    const claimError = await publishInitializedFile(
      claimPath,
      recoveryOwnerContents,
    );
    if (claimError === undefined) {
      let released = false;
      return {
        release: async () => {
          if (released) return;
          await cleanupRecoveryClaims(lockPath, staleContents, depth);
          released = true;
        },
      };
    }
    if (!hasErrorCode(claimError, "EEXIST")) {
      throw new ManualListenerLockUnavailableError(
        `Could not safely claim listener lock mutation: ${
          claimError instanceof Error ? claimError.message : String(claimError)
        }`,
        lockPath,
      );
    }

    let claimContents: string;
    try {
      claimContents = await readFile(claimPath, "utf-8");
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) continue;
      throw new ManualListenerLockUnavailableError(
        "Could not inspect the listener lock mutation owner.",
        lockPath,
      );
    }
    const claimOwner = parseLockRecord(claimContents, scopeHash);
    if (!claimOwner) {
      throw new ManualListenerLockUnavailableError(
        `Listener lock mutation record is invalid: ${claimPath}`,
        lockPath,
      );
    }
    if (await isLockOwnerAlive(claimOwner, lockPath, deps)) {
      return null;
    }
  }

  throw new ManualListenerLockUnavailableError(
    "Listener lock mutation claim chain was exhausted.",
    lockPath,
  );
}

async function recoverDeadOwner(
  lockPath: string,
  staleContents: string,
  recoveryOwnerContents: string,
  scopeHash: string,
  deps: ManualListenerLockDeps,
): Promise<boolean> {
  const claim = await acquireRecoveryClaim(
    lockPath,
    staleContents,
    recoveryOwnerContents,
    scopeHash,
    deps,
  );
  if (!claim) return false;
  try {
    let currentContents: string;
    try {
      currentContents = await readFile(lockPath, "utf-8");
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    }
    if (currentContents !== staleContents) return true;

    const staleOwner = parseLockRecord(staleContents, scopeHash);
    if (staleOwner && (await isLockOwnerAlive(staleOwner, lockPath, deps))) {
      return false;
    }
    await unlink(lockPath);
    if (staleOwner?.leaseVersion === 1) {
      await rm(getOwnerHeartbeatPath(lockPath, staleOwner.ownerToken), {
        force: true,
      }).catch(() => {});
    }
    return true;
  } finally {
    await claim.release();
  }
}

/**
 * Claim the local slot used by a standalone remote listener.
 *
 * The initialized-record hard-link publication makes acquisition atomic. A
 * dead owner is reclaimed through a content-scoped recovery claim so two
 * simultaneous recoverers cannot unlink a newer generation.
 */
export async function acquireManualListenerLock(
  scope: ManualListenerLockScope,
  overrides: Partial<ManualListenerLockDeps> = {},
): Promise<ManualListenerLockHandle> {
  const scopeHash = getManualListenerScopeHash(scope);
  const deps: ManualListenerLockDeps = {
    lockRoot: getDefaultLockRoot(),
    processId: process.pid,
    ownerToken: randomUUID(),
    isProcessAlive: defaultIsProcessAlive,
    readProcessIdentity: readLinuxProcessIdentity,
    isOwnerHeartbeatFresh: defaultIsOwnerHeartbeatFresh,
    onLeaseLost: () => process.kill(process.pid, "SIGTERM"),
    ...overrides,
  };
  const listenerLockDir = path.join(deps.lockRoot, "listeners");
  const lockPath = path.join(listenerLockDir, `manual-${scopeHash}.lock`);
  const processIdentity = deps.readProcessIdentity(deps.processId);
  const ownerRecord: ManualListenerLockRecord = {
    version: 1,
    pid: deps.processId,
    ownerToken: deps.ownerToken,
    acquiredAt: new Date().toISOString(),
    scopeHash,
    leaseVersion: 1,
    processStartTicks: processIdentity?.startTicks ?? null,
    bootId: processIdentity?.bootId ?? null,
    pidNamespace: processIdentity?.pidNamespace ?? null,
  };
  const ownerContents = JSON.stringify(ownerRecord);

  try {
    await mkdir(listenerLockDir, { recursive: true });
  } catch (error) {
    throw new ManualListenerLockUnavailableError(
      `Could not create the listener lock directory: ${
        error instanceof Error ? error.message : String(error)
      }`,
      lockPath,
    );
  }

  let heartbeat: Awaited<ReturnType<typeof createOwnerHeartbeat>>;
  try {
    heartbeat = await createOwnerHeartbeat(
      lockPath,
      deps.ownerToken,
      ownerContents,
      scopeHash,
      deps,
      deps.onLeaseLost,
    );
  } catch (error) {
    throw new ManualListenerLockUnavailableError(
      `Could not create the listener ownership heartbeat: ${
        error instanceof Error ? error.message : String(error)
      }`,
      lockPath,
    );
  }

  try {
    while (true) {
      const publicationError = await publishInitializedFile(
        lockPath,
        ownerContents,
      );
      if (publicationError === undefined) {
        let released = false;
        heartbeat.start();
        return {
          lockPath,
          release: async () => {
            if (released) return;
            await heartbeat.stop();
            released = true;
          },
        };
      }
      if (!hasErrorCode(publicationError, "EEXIST")) {
        throw new ManualListenerLockUnavailableError(
          `Could not publish the listener lock: ${
            publicationError instanceof Error
              ? publicationError.message
              : String(publicationError)
          }`,
          lockPath,
        );
      }

      let incumbentContents: string;
      try {
        incumbentContents = await readFile(lockPath, "utf-8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw new ManualListenerLockUnavailableError(
          "Could not inspect the existing listener lock.",
          lockPath,
        );
      }
      const incumbent = parseLockRecord(incumbentContents, scopeHash);
      if (!incumbent) {
        throw new ManualListenerLockUnavailableError(
          `Listener lock is corrupt or belongs to an incompatible version: ${lockPath}`,
          lockPath,
        );
      }
      if (await isLockOwnerAlive(incumbent, lockPath, deps)) {
        throw new ManualListenerAlreadyRunningError(incumbent.pid, lockPath);
      }

      const recovered = await recoverDeadOwner(
        lockPath,
        incumbentContents,
        ownerContents,
        scopeHash,
        deps,
      );
      if (!recovered) {
        throw new ManualListenerLockUnavailableError(
          `Another process is recovering the listener lock: ${lockPath}`,
          lockPath,
        );
      }
    }
  } catch (error) {
    await heartbeat.stop().catch(() => {});
    throw error;
  }
}
