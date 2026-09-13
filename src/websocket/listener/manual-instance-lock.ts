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
import { link, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
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
}

interface ManualListenerLockDeps {
  lockRoot: string;
  processId: number;
  ownerToken: string;
  isProcessAlive: (pid: number) => boolean;
}

const RECOVERY_MAX_DEPTH = 64;

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

async function recoverDeadOwner(
  lockPath: string,
  staleContents: string,
  recoveryOwnerContents: string,
  scopeHash: string,
  deps: ManualListenerLockDeps,
): Promise<boolean> {
  let ownedClaimDepth = -1;
  try {
    for (let depth = 0; depth < RECOVERY_MAX_DEPTH; depth++) {
      const claimPath = getRecoveryClaimPath(lockPath, staleContents, depth);
      const claimError = await publishInitializedFile(
        claimPath,
        recoveryOwnerContents,
      );
      if (claimError === undefined) {
        ownedClaimDepth = depth;
        break;
      }
      if (!hasErrorCode(claimError, "EEXIST")) {
        throw new ManualListenerLockUnavailableError(
          `Could not safely claim stale listener lock recovery: ${
            claimError instanceof Error
              ? claimError.message
              : String(claimError)
          }`,
          lockPath,
        );
      }

      let claimContents: string;
      try {
        claimContents = await readFile(claimPath, "utf-8");
      } catch (error) {
        if (hasErrorCode(error, "ENOENT")) {
          continue;
        }
        throw new ManualListenerLockUnavailableError(
          "Could not inspect the listener lock recovery owner.",
          lockPath,
        );
      }
      const claimOwner = parseLockRecord(claimContents, scopeHash);
      if (!claimOwner) {
        throw new ManualListenerLockUnavailableError(
          `Listener lock recovery record is invalid: ${claimPath}`,
          lockPath,
        );
      }
      if (deps.isProcessAlive(claimOwner.pid)) {
        return false;
      }
    }

    if (ownedClaimDepth === -1) {
      throw new ManualListenerLockUnavailableError(
        "Listener lock recovery claim chain was exhausted.",
        lockPath,
      );
    }

    let currentContents: string;
    try {
      currentContents = await readFile(lockPath, "utf-8");
    } catch (error) {
      return hasErrorCode(error, "ENOENT");
    }
    if (currentContents !== staleContents) {
      return true;
    }
    await unlink(lockPath);
    return true;
  } finally {
    if (ownedClaimDepth !== -1) {
      await cleanupRecoveryClaims(lockPath, staleContents, ownedClaimDepth);
    }
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
    ...overrides,
  };
  const listenerLockDir = path.join(deps.lockRoot, "listeners");
  const lockPath = path.join(listenerLockDir, `manual-${scopeHash}.lock`);
  const ownerRecord: ManualListenerLockRecord = {
    version: 1,
    pid: deps.processId,
    ownerToken: deps.ownerToken,
    acquiredAt: new Date().toISOString(),
    scopeHash,
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

  while (true) {
    const publicationError = await publishInitializedFile(
      lockPath,
      ownerContents,
    );
    if (publicationError === undefined) {
      let released = false;
      return {
        lockPath,
        release: async () => {
          if (released) return;
          let currentContents: string;
          try {
            currentContents = await readFile(lockPath, "utf-8");
          } catch (error) {
            if (hasErrorCode(error, "ENOENT")) {
              released = true;
              return;
            }
            throw error;
          }
          if (currentContents === ownerContents) {
            await unlink(lockPath);
          }
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
    if (deps.isProcessAlive(incumbent.pid)) {
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
}
