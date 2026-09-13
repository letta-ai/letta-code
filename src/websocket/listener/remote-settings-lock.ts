/**
 * Cross-process lock for remote-settings.json.
 *
 * Primary locks and recovery claims are fully initialized before hard-link
 * publication, so another process never observes an ownerless lock. Recovery
 * claims form an immutable chain scoped to one dead primary token: a live
 * claim owner blocks recovery, while a crashed recovery owner is bypassed at
 * the next depth. This prevents two recoverers from unlinking different
 * generations of the primary lock.
 *
 * The protocol is for a local filesystem shared by processes on one host. A
 * listener upgrade must stop the old listener before starting code that uses a
 * different lock protocol.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export interface RemoteSettingsLockHandle {
  lockPath: string;
  ownerToken: string;
}

let activeLock: RemoteSettingsLockHandle | null = null;
let abandonedLock: RemoteSettingsLockHandle | null = null;
let acquisitionInProgress = false;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;

const LOCK_CLEANUP_RETRY_MS = 250;
const RECOVERY_MAX_DEPTH = 256;
const FLUSH_RETRY_MIN_MS = 10;
const FLUSH_RETRY_JITTER_MS = 30;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function createOwnerToken(): string {
  return `${process.pid}-${randomUUID()}`;
}

function lockHandlesEqual(
  left: RemoteSettingsLockHandle | null,
  right: RemoteSettingsLockHandle,
): boolean {
  return (
    left?.lockPath === right.lockPath && left.ownerToken === right.ownerToken
  );
}

function isLockOwnerProcessAlive(ownerToken: string): boolean {
  const separatorIndex = ownerToken.indexOf("-");
  const ownerPid = Number(
    separatorIndex === -1 ? ownerToken : ownerToken.slice(0, separatorIndex),
  );
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;

  try {
    process.kill(ownerPid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only result that proves the process is gone. Access
    // failures and unfamiliar platform errors must fail safe.
    return !hasErrorCode(error, "ESRCH");
  }
}

function getRecoverableLockTokenSync(lockPath: string): string | null {
  try {
    const ownerToken = readFileSync(lockPath, "utf-8");
    return isLockOwnerProcessAlive(ownerToken) ? null : ownerToken;
  } catch {
    return null;
  }
}

async function getRecoverableLockToken(
  lockPath: string,
): Promise<string | null> {
  try {
    const ownerToken = await readFile(lockPath, "utf-8");
    return isLockOwnerProcessAlive(ownerToken) ? null : ownerToken;
  } catch {
    return null;
  }
}

function getRecoveryClaimPath(
  lockPath: string,
  staleToken: string,
  depth: number,
): string {
  const tokenHash = createHash("sha256").update(staleToken).digest("hex");
  return `${lockPath}.recover.${tokenHash}.${depth}`;
}

function createInitializedTokenLinkSync(
  targetPath: string,
  ownerToken: string,
): unknown {
  const candidatePath = path.join(
    path.dirname(targetPath),
    `.remote-settings-lock-${randomUUID()}.candidate`,
  );
  let acquisitionError: unknown;
  try {
    writeFileSync(candidatePath, ownerToken, { flag: "wx" });
    linkSync(candidatePath, targetPath);
  } catch (error) {
    acquisitionError = error;
  }
  try {
    rmSync(candidatePath, { force: true });
  } catch {
    // Candidate names are unique and never participate in lock ownership.
  }
  return acquisitionError;
}

async function createInitializedTokenLink(
  targetPath: string,
  ownerToken: string,
): Promise<unknown> {
  const candidatePath = path.join(
    path.dirname(targetPath),
    `.remote-settings-lock-${randomUUID()}.candidate`,
  );
  let acquisitionError: unknown;
  try {
    await writeFile(candidatePath, ownerToken, { flag: "wx" });
    await link(candidatePath, targetPath);
  } catch (error) {
    acquisitionError = error;
  }
  await rm(candidatePath, { force: true }).catch(() => {});
  return acquisitionError;
}

function cleanupRecoveryClaimsSync(
  lockPath: string,
  staleToken: string,
  deepestClaim: number,
): void {
  for (let depth = deepestClaim; depth >= 0; depth--) {
    try {
      rmSync(getRecoveryClaimPath(lockPath, staleToken, depth), {
        force: true,
      });
    } catch {
      // Claim paths are unique to the dead token and never protect a later
      // primary lock, so failed cleanup is harmless.
    }
  }
}

async function cleanupRecoveryClaims(
  lockPath: string,
  staleToken: string,
  deepestClaim: number,
): Promise<void> {
  for (let depth = deepestClaim; depth >= 0; depth--) {
    await rm(getRecoveryClaimPath(lockPath, staleToken, depth), {
      force: true,
    }).catch(() => {});
  }
}

function recoverStaleLockSync(
  lockPath: string,
  staleToken: string,
  recoveryOwner: string,
): boolean {
  let ownedClaimDepth = -1;
  try {
    for (let depth = 0; depth < RECOVERY_MAX_DEPTH; depth++) {
      const claimPath = getRecoveryClaimPath(lockPath, staleToken, depth);
      const claimError = createInitializedTokenLinkSync(
        claimPath,
        recoveryOwner,
      );
      if (claimError === undefined) {
        ownedClaimDepth = depth;
        break;
      }
      if (!hasErrorCode(claimError, "EEXIST")) return false;

      let claimOwner: string;
      try {
        claimOwner = readFileSync(claimPath, "utf-8");
      } catch {
        return false;
      }
      if (claimOwner === recoveryOwner) {
        ownedClaimDepth = depth;
        break;
      }
      if (isLockOwnerProcessAlive(claimOwner)) return false;
    }
    if (ownedClaimDepth === -1) {
      if (process.env.LETTA_DEBUG) {
        console.warn("[Remote Settings] Lock recovery claim chain exhausted");
      }
      return false;
    }
    if (readFileSync(lockPath, "utf-8") !== staleToken) return false;
    rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    if (ownedClaimDepth !== -1) {
      cleanupRecoveryClaimsSync(lockPath, staleToken, ownedClaimDepth);
    }
  }
}

async function recoverStaleLock(
  lockPath: string,
  staleToken: string,
  recoveryOwner: string,
): Promise<boolean> {
  let ownedClaimDepth = -1;
  try {
    for (let depth = 0; depth < RECOVERY_MAX_DEPTH; depth++) {
      const claimPath = getRecoveryClaimPath(lockPath, staleToken, depth);
      const claimError = await createInitializedTokenLink(
        claimPath,
        recoveryOwner,
      );
      if (claimError === undefined) {
        ownedClaimDepth = depth;
        break;
      }
      if (!hasErrorCode(claimError, "EEXIST")) return false;

      let claimOwner: string;
      try {
        claimOwner = await readFile(claimPath, "utf-8");
      } catch {
        return false;
      }
      if (claimOwner === recoveryOwner) {
        ownedClaimDepth = depth;
        break;
      }
      if (isLockOwnerProcessAlive(claimOwner)) return false;
    }
    if (ownedClaimDepth === -1) {
      if (process.env.LETTA_DEBUG) {
        console.warn("[Remote Settings] Lock recovery claim chain exhausted");
      }
      return false;
    }
    if ((await readFile(lockPath, "utf-8")) !== staleToken) return false;
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  } finally {
    if (ownedClaimDepth !== -1) {
      await cleanupRecoveryClaims(lockPath, staleToken, ownedClaimDepth);
    }
  }
}

function reclaimAbandonedLockSync(
  lockPath: string,
  allowDuringAcquisition = false,
): boolean {
  const handle = abandonedLock;
  if (!handle || handle.lockPath !== lockPath || activeLock) return false;
  if (acquisitionInProgress && !allowDuringAcquisition) return false;

  try {
    if (readFileSync(handle.lockPath, "utf-8") !== handle.ownerToken) {
      abandonedLock = null;
      return false;
    }
    rmSync(handle.lockPath, { force: true });
    abandonedLock = null;
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      abandonedLock = null;
      return true;
    }
    return false;
  }
}

async function reclaimAbandonedLock(
  lockPath: string,
  allowDuringAcquisition = false,
): Promise<boolean> {
  const handle = abandonedLock;
  if (!handle || handle.lockPath !== lockPath || activeLock) return false;
  if (acquisitionInProgress && !allowDuringAcquisition) return false;

  try {
    if ((await readFile(handle.lockPath, "utf-8")) !== handle.ownerToken) {
      abandonedLock = null;
      return false;
    }
    await rm(handle.lockPath, { force: true });
    abandonedLock = null;
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      abandonedLock = null;
      return true;
    }
    return false;
  }
}

function clearCleanupTimer(): void {
  if (cleanupTimer) {
    clearTimeout(cleanupTimer);
    cleanupTimer = null;
  }
}

function scheduleAbandonedLockCleanup(): void {
  if (cleanupTimer || !abandonedLock) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    const handle = abandonedLock;
    if (!handle) return;
    if (activeLock || acquisitionInProgress) {
      scheduleAbandonedLockCleanup();
      return;
    }
    reclaimAbandonedLockSync(handle.lockPath);
    if (abandonedLock) scheduleAbandonedLockCleanup();
  }, LOCK_CLEANUP_RETRY_MS);
  cleanupTimer.unref();
}

function attemptAcquireLockSync(
  lockPath: string,
): RemoteSettingsLockHandle | null {
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }

  const ownerToken = createOwnerToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const acquisitionError = createInitializedTokenLinkSync(
      lockPath,
      ownerToken,
    );
    if (acquisitionError === undefined) {
      const handle = { lockPath, ownerToken };
      activeLock = handle;
      return handle;
    }
    if (
      hasErrorCode(acquisitionError, "EEXIST") &&
      reclaimAbandonedLockSync(lockPath, true)
    ) {
      continue;
    }
    const staleToken = getRecoverableLockTokenSync(lockPath);
    if (
      attempt > 0 ||
      !hasErrorCode(acquisitionError, "EEXIST") ||
      staleToken === null ||
      !recoverStaleLockSync(lockPath, staleToken, ownerToken)
    ) {
      return null;
    }
  }
  return null;
}

async function attemptAcquireLock(
  lockPath: string,
): Promise<RemoteSettingsLockHandle | null> {
  try {
    await mkdir(path.dirname(lockPath), { recursive: true });
  } catch {
    return null;
  }

  const ownerToken = createOwnerToken();
  for (let attempt = 0; attempt < 2; attempt++) {
    const acquisitionError = await createInitializedTokenLink(
      lockPath,
      ownerToken,
    );
    if (acquisitionError === undefined) {
      const handle = { lockPath, ownerToken };
      activeLock = handle;
      return handle;
    }
    if (
      hasErrorCode(acquisitionError, "EEXIST") &&
      (await reclaimAbandonedLock(lockPath, true))
    ) {
      continue;
    }
    const staleToken = await getRecoverableLockToken(lockPath);
    if (
      attempt > 0 ||
      !hasErrorCode(acquisitionError, "EEXIST") ||
      staleToken === null ||
      !(await recoverStaleLock(lockPath, staleToken, ownerToken))
    ) {
      return null;
    }
  }
  return null;
}

export function tryAcquireRemoteSettingsLockSync(
  lockPath: string,
): RemoteSettingsLockHandle | null {
  if (activeLock || acquisitionInProgress) return null;
  acquisitionInProgress = true;
  try {
    return attemptAcquireLockSync(lockPath);
  } finally {
    acquisitionInProgress = false;
  }
}

export async function tryAcquireRemoteSettingsLock(
  lockPath: string,
): Promise<RemoteSettingsLockHandle | null> {
  if (activeLock || acquisitionInProgress) return null;
  acquisitionInProgress = true;
  try {
    return await attemptAcquireLock(lockPath);
  } finally {
    acquisitionInProgress = false;
  }
}

export function releaseRemoteSettingsLockSync(
  handle: RemoteSettingsLockHandle,
): void {
  if (!lockHandlesEqual(activeLock, handle)) return;
  let released = false;
  try {
    if (readFileSync(handle.lockPath, "utf-8") !== handle.ownerToken) {
      released = true;
    } else {
      rmSync(handle.lockPath, { force: true });
      released = true;
    }
  } catch (error) {
    released = hasErrorCode(error, "ENOENT");
  } finally {
    activeLock = null;
  }
  if (!released) {
    abandonedLock = handle;
    scheduleAbandonedLockCleanup();
  }
}

export async function releaseRemoteSettingsLock(
  handle: RemoteSettingsLockHandle,
): Promise<void> {
  if (!lockHandlesEqual(activeLock, handle)) return;
  let released = false;
  try {
    if ((await readFile(handle.lockPath, "utf-8")) !== handle.ownerToken) {
      released = true;
    } else {
      await rm(handle.lockPath, { force: true });
      released = true;
    }
  } catch (error) {
    released = hasErrorCode(error, "ENOENT");
  } finally {
    activeLock = null;
  }
  if (!released) {
    abandonedLock = handle;
    scheduleAbandonedLockCleanup();
  }
}

export async function flushAbandonedRemoteSettingsLock(
  deadline: number,
): Promise<boolean> {
  clearCleanupTimer();
  while (abandonedLock && !activeLock && !acquisitionInProgress) {
    const handle = abandonedLock;
    reclaimAbandonedLockSync(handle.lockPath);
    if (!abandonedLock) return true;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    const retryDelayMs = Math.min(
      remainingMs,
      FLUSH_RETRY_MIN_MS + Math.floor(Math.random() * FLUSH_RETRY_JITTER_MS),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
  }

  if (abandonedLock) scheduleAbandonedLockCleanup();
  return abandonedLock === null;
}
