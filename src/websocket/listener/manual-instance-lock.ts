import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { uptime } from "node:os";
import path from "node:path";
import {
  isWithinPartialPublishGrace,
  publishExclusive,
} from "@/utils/exclusive-publish";
import {
  getOwnProcessStartTime,
  getProcessCommand,
  getProcessStartTime,
  isPidReusedByNonLetta,
} from "@/utils/process-liveness";
import { resolveGlobalConfigDir } from "@/utils/settings-path";

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
  started?: string;
}

interface ManualListenerLockDeps {
  lockRoot: string;
  processId: number;
  ownerToken: string;
  isProcessAlive: (pid: number) => boolean;
  bootTimeMs: number;
  getProcessCommand: (pid: number) => string | null;
  getOwnProcessStartTime: () => Promise<string | null>;
  getProcessStartTime: (pid: number) => Promise<string | null>;
}

const RECOVERY_MAX_DEPTH = 64;
const BOOT_TIME_SLACK_MS = 60_000;

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
    return !hasErrorCode(error, "ESRCH");
  }
}

function getDefaultBootTimeMs(): number {
  return Date.now() - uptime() * 1000;
}

async function isOwnerAlive(
  record: ManualListenerLockRecord,
  deps: ManualListenerLockDeps,
): Promise<boolean> {
  if (!deps.isProcessAlive(record.pid)) return false;
  if (record.started) {
    const started = await deps.getProcessStartTime(record.pid);
    return started === null || started === record.started;
  }
  const acquiredAtMs = Date.parse(record.acquiredAt);
  if (
    !Number.isFinite(acquiredAtMs) ||
    acquiredAtMs >= deps.bootTimeMs - BOOT_TIME_SLACK_MS
  ) {
    return true;
  }
  return !isPidReusedByNonLetta(record.pid, deps.getProcessCommand);
}

export function getManualListenerLockRoot(): string {
  return resolveGlobalConfigDir();
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

type ParsedLockRecord =
  | { kind: "record"; record: ManualListenerLockRecord }
  | { kind: "partial" }
  | { kind: "incompatible" };

function classifyLockRecord(
  raw: string,
  expectedScopeHash: string,
): ParsedLockRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "partial" };
  }
  const record = validateLockRecord(parsed, expectedScopeHash);
  return record ? { kind: "record", record } : { kind: "incompatible" };
}

async function isAbandonedPartialRecord(
  filePath: string,
): Promise<boolean | null> {
  try {
    return !isWithinPartialPublishGrace((await stat(filePath)).mtimeMs);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  }
}

function validateLockRecord(
  parsed: unknown,
  expectedScopeHash: string,
): ManualListenerLockRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Partial<ManualListenerLockRecord>;
  if (
    record.version !== 1 ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid ?? 0) <= 0 ||
    typeof record.ownerToken !== "string" ||
    record.ownerToken.length === 0 ||
    typeof record.acquiredAt !== "string" ||
    (record.started !== undefined &&
      (typeof record.started !== "string" || record.started.length === 0)) ||
    record.scopeHash !== expectedScopeHash
  ) {
    return null;
  }
  return record as ManualListenerLockRecord;
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
    await publishExclusive(candidatePath, targetPath);
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
  staleIsPartial = false,
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
      const claimOwner = classifyLockRecord(claimContents, scopeHash);
      if (claimOwner.kind === "incompatible") {
        throw new ManualListenerLockUnavailableError(
          `Listener lock recovery record is invalid: ${claimPath}`,
          lockPath,
        );
      }
      if (claimOwner.kind === "partial") {
        const abandoned = await isAbandonedPartialRecord(claimPath).catch(
          () => false,
        );
        if (abandoned === false) return false;
        continue;
      }
      if (await isOwnerAlive(claimOwner.record, deps)) {
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
    if (
      staleIsPartial &&
      (await isAbandonedPartialRecord(lockPath).catch(() => false)) !== true
    ) {
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

export async function acquireManualListenerLock(
  scope: ManualListenerLockScope,
  overrides: Partial<ManualListenerLockDeps> = {},
): Promise<ManualListenerLockHandle> {
  const scopeHash = getManualListenerScopeHash(scope);
  const deps: ManualListenerLockDeps = {
    lockRoot: getManualListenerLockRoot(),
    processId: process.pid,
    ownerToken: randomUUID(),
    isProcessAlive: defaultIsProcessAlive,
    bootTimeMs: getDefaultBootTimeMs(),
    getProcessCommand,
    getOwnProcessStartTime,
    getProcessStartTime,
    ...overrides,
  };
  const listenerLockDir = path.join(deps.lockRoot, "listeners");
  const lockPath = path.join(listenerLockDir, `manual-${scopeHash}.lock`);
  const started = (await deps.getOwnProcessStartTime()) ?? undefined;
  const ownerRecord: ManualListenerLockRecord = {
    version: 1,
    pid: deps.processId,
    ownerToken: deps.ownerToken,
    acquiredAt: new Date().toISOString(),
    scopeHash,
    ...(started ? { started } : {}),
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
    const incumbent = classifyLockRecord(incumbentContents, scopeHash);
    if (incumbent.kind === "incompatible") {
      throw new ManualListenerLockUnavailableError(
        `Listener lock is corrupt or belongs to an incompatible version: ${lockPath}`,
        lockPath,
      );
    }
    if (incumbent.kind === "partial") {
      let abandoned: boolean | null;
      try {
        abandoned = await isAbandonedPartialRecord(lockPath);
      } catch {
        throw new ManualListenerLockUnavailableError(
          "Could not inspect the existing listener lock.",
          lockPath,
        );
      }
      if (abandoned === null) continue;
      if (!abandoned) {
        throw new ManualListenerLockUnavailableError(
          `Listener lock is being written by another process: ${lockPath}`,
          lockPath,
        );
      }
    } else if (await isOwnerAlive(incumbent.record, deps)) {
      throw new ManualListenerAlreadyRunningError(
        incumbent.record.pid,
        lockPath,
      );
    }

    const recovered = await recoverDeadOwner(
      lockPath,
      incumbentContents,
      ownerContents,
      scopeHash,
      deps,
      incumbent.kind === "partial",
    );
    if (!recovered) {
      throw new ManualListenerLockUnavailableError(
        `Another process is recovering the listener lock: ${lockPath}`,
        lockPath,
      );
    }
  }
}
