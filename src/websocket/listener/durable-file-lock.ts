import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const MAX_OWNER_BYTES = 4096;
const WAIT_SLICE_MS = 5;
const PROCESS_START_PROBE_TIMEOUT_MS = 250;
const MAX_CANDIDATE_SWEEP = 128;
const INSTALLING_OWNER_NAME = ".installing";
let cachedCurrentProcessStart: string | null | undefined;

export type DurableLockOwner = {
  token: string;
  pid: number;
  processStart: string | null;
};

export type DurableFileLockOptions = {
  waitMs?: number;
  owner?: DurableLockOwner;
  isOwnerAlive?: (owner: DurableLockOwner) => boolean;
  /** @deprecated Retained for source compatibility with the former file lock. */
  beforeExactUnlink?: (path: string) => void;
  /** Deterministic race injection used by the lock's adversarial tests. */
  afterOwnerUnlink?: (lockPath: string) => void;
  /** Deterministic injection after mkdir, before the candidate owner is linked. */
  afterInstallMkdir?: (lockPath: string) => void;
  /** Failure seams after canonical publication, used to prove orphan cleanup. */
  afterCanonicalOwnerLink?: (lockPath: string) => void;
  afterCanonicalDirectorySync?: (lockPath: string) => void;
  afterInstallingOwnerUnlink?: (lockPath: string) => void;
  /** Deterministic injection after observing an empty incumbent directory. */
  beforeEmptyCleanup?: (lockPath: string) => void;
  /** Deterministic clock and backoff seams used by bounded-retry tests. */
  now?: () => number;
  sleep?: (milliseconds: number) => void;
};

type ProcessStartCommand = (
  executable: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; timeout?: number },
) => string;
type ProcessProbe = (pid: number) => void;

function installCandidateDirectory(
  candidatePath: string,
  lockPath: string,
  hooks: Pick<
    DurableFileLockOptions,
    | "afterInstallMkdir"
    | "afterCanonicalOwnerLink"
    | "afterCanonicalDirectorySync"
    | "afterInstallingOwnerUnlink"
  >,
): boolean {
  // mkdir is the one portable no-replacement primitive available on every
  // supported platform. A stale empty-directory cleanup can still pass its
  // identity check before this mkdir and remove this directory afterward. Keep
  // the already-fsynced candidate intact and link (rather than move) its unique
  // owner into the canonical directory so that installation can verify which
  // directory received the link and retry safely when it lost that race.
  mkdirSync(lockPath, { mode: 0o700 });
  const directoryIdentity = pathIdentity(lockPath);
  if (!directoryIdentity) return false;
  const names = readdirSync(candidatePath);
  if (names.length !== 1) throw new Error("Invalid durable lock candidate");
  const candidateOwnerPath = join(candidatePath, names[0] as string);
  const installingOwnerPath = join(lockPath, INSTALLING_OWNER_NAME);
  const installedOwnerPath = join(lockPath, names[0] as string);
  hooks.afterInstallMkdir?.(lockPath);
  try {
    // The fixed installation name elects at most one installer in a directory.
    // In particular, a delayed installer cannot add its unique owner alongside
    // an owner that already populated a replacement directory.
    linkSync(candidateOwnerPath, installingOwnerPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EEXIST") return false;
    throw error;
  }

  // The installation link pins whichever directory received it. If stale
  // cleanup replaced our mkdir before the link, relinquish the fixed name and
  // retry; the private candidate still contains the durable owner record.
  const installingNames = readdirSync(lockPath);
  if (
    !hasPathIdentity(lockPath, directoryIdentity) ||
    installingNames.length !== 1 ||
    installingNames[0] !== INSTALLING_OWNER_NAME
  ) {
    if (sameFile(candidateOwnerPath, installingOwnerPath)) {
      unlinkSync(installingOwnerPath);
      fsyncDirectory(lockPath);
    }
    return false;
  }

  linkSync(candidateOwnerPath, installedOwnerPath);
  hooks.afterCanonicalOwnerLink?.(lockPath);
  fsyncDirectory(lockPath);
  hooks.afterCanonicalDirectorySync?.(lockPath);
  unlinkSync(installingOwnerPath);
  hooks.afterInstallingOwnerUnlink?.(lockPath);
  fsyncDirectory(lockPath);
  unlinkSync(candidateOwnerPath);
  rmdirSync(candidatePath);
  return true;
}

/** Windows does not support opening/fsyncing directories. File fsyncs still run. */
export function fsyncDirectory(
  path: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Synchronous process identity for a synchronous inter-process lock protocol. */
export function getProcessStart(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  run: ProcessStartCommand = (executable, args, options) =>
    execFileSync(executable, args, {
      ...options,
      encoding: "utf8",
      windowsHide: true,
    }),
  timeoutMs: number = PROCESS_START_PROBE_TIMEOUT_MS,
): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const closeParen = stat.lastIndexOf(")");
      if (closeParen < 0) return null;
      return stat.slice(closeParen + 2).split(" ")[19] ?? null;
    }
    const started =
      platform === "win32"
        ? run(
            "powershell",
            [
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
            ],
            { timeout: timeoutMs },
          )
        : run("ps", ["-o", "lstart=", "-p", String(pid)], {
            env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
            timeout: timeoutMs,
          });
    return started.trim() || null;
  } catch {
    return null;
  }
}

export function currentDurableLockOwner(
  processStartTimeoutMs: number = PROCESS_START_PROBE_TIMEOUT_MS,
): DurableLockOwner {
  let processStart = cachedCurrentProcessStart;
  if (processStart === undefined) {
    processStart = getProcessStart(
      process.pid,
      process.platform,
      undefined,
      processStartTimeoutMs,
    );
    // A short lock-acquisition deadline may not leave enough time for the first
    // platform process probe. Cache only a proven identity so a transient null
    // cannot poison every later owner token in this long-lived daemon.
    if (processStart !== null) cachedCurrentProcessStart = processStart;
  }
  return {
    token: randomUUID(),
    pid: process.pid,
    processStart: processStart ?? null,
  };
}

export function durableLockOwnerIsAlive(
  owner: DurableLockOwner,
  readStart: (pid: number) => string | null = getProcessStart,
  probe: ProcessProbe = (pid) => process.kill(pid, 0),
): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    probe(owner.pid);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
    // EPERM proves the pid is reachable, not that it is still the same process.
  }
  const actualStart = readStart(owner.pid);
  // Unknown identity fails closed: evict a reachable process only when both
  // recorded and current creation identities prove that the pid was reused.
  return (
    owner.processStart === null ||
    actualStart === null ||
    owner.processStart === actualStart
  );
}

function parseOwner(value: unknown): DurableLockOwner {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).token !== "string" ||
    !/^[A-Za-z0-9-]{1,128}$/.test(
      (value as Record<string, unknown>).token as string,
    ) ||
    !Number.isSafeInteger((value as Record<string, unknown>).pid) ||
    ((value as Record<string, unknown>).pid as number) <= 0 ||
    ((value as Record<string, unknown>).processStart !== null &&
      typeof (value as Record<string, unknown>).processStart !== "string")
  ) {
    throw new Error("Invalid durable lock owner");
  }
  return value as DurableLockOwner;
}

function ownerFileName(owner: DurableLockOwner): string {
  return `${owner.pid}-${owner.token}.json`;
}

function readOwnerDirectory(lockPath: string): {
  owner: DurableLockOwner;
  ownerPath: string;
} | null {
  const names = readdirSync(lockPath);
  // Empty directories are recognizable crash artifacts from the interval between
  // removing a dead owner and rmdir. Populated directories are never published
  // empty, so a contender may safely finish that cleanup.
  if (names.length === 0) return null;
  if (names.length > 2) {
    throw new Error("Invalid durable lock owner directory");
  }
  const firstPath = join(lockPath, names[0] as string);
  const fd = openSync(firstPath, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) {
      throw new Error("Invalid durable lock owner file");
    }
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read !== bytes.length) throw new Error("Short durable lock owner read");
    const owner = parseOwner(JSON.parse(bytes.toString("utf8")));
    const stableName = ownerFileName(owner);
    const validNames =
      (names.length === 1 &&
        (names[0] === stableName || names[0] === INSTALLING_OWNER_NAME)) ||
      (names.length === 2 &&
        names.includes(stableName) &&
        names.includes(INSTALLING_OWNER_NAME) &&
        sameFile(
          join(lockPath, stableName),
          join(lockPath, INSTALLING_OWNER_NAME),
        ));
    if (!validNames) throw new Error("Invalid durable lock owner filename");
    return {
      owner,
      ownerPath: join(
        lockPath,
        names.includes(stableName) ? stableName : INSTALLING_OWNER_NAME,
      ),
    };
  } finally {
    closeSync(fd);
  }
}

function readOwnerFile(path: string): DurableLockOwner {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) {
      throw new Error("Invalid durable lock owner file");
    }
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read !== bytes.length) throw new Error("Short durable lock owner read");
    return parseOwner(JSON.parse(bytes.toString("utf8")));
  } finally {
    closeSync(fd);
  }
}

function sameFile(first: string, second: string): boolean {
  try {
    const left = lstatSync(first);
    const right = lstatSync(second);
    return left.dev === right.dev && left.ino === right.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

type FileIdentity = { dev: number | bigint; ino: number | bigint };

function pathIdentity(path: string): FileIdentity | null {
  try {
    const stat = lstatSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function hasPathIdentity(path: string, expected: FileIdentity): boolean {
  const current = pathIdentity(path);
  return current?.dev === expected.dev && current.ino === expected.ino;
}

function removeDirectoryIfEmpty(
  path: string,
  parent: string,
  expectedIdentity?: FileIdentity,
): boolean {
  if (expectedIdentity && !hasPathIdentity(path, expectedIdentity))
    return false;
  try {
    rmdirSync(path);
    fsyncDirectory(parent);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTEMPTY" || code === "EEXIST") {
      return false;
    }
    throw error;
  }
}

function removeDeadOwner(
  lockPath: string,
  parent: string,
  ownerPath: string,
  afterOwnerUnlink?: (lockPath: string) => void,
): boolean {
  const directoryIdentity = pathIdentity(lockPath);
  if (!directoryIdentity) return false;
  let removed = false;
  try {
    unlinkSync(ownerPath);
    removed = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The unique filename is the identity check. If another contender atomically
  // installs M1 over this now-empty M0 directory, it has a different populated
  // filename: this stale rmdir cannot remove it.
  if (!removed) return false;
  afterOwnerUnlink?.(lockPath);
  removeDirectoryIfEmpty(lockPath, parent, directoryIdentity);
  return true;
}

function sweepDeadCandidates(
  lockPath: string,
  parent: string,
  isOwnerAlive: (owner: DurableLockOwner) => boolean,
  ignoredPath?: string,
): boolean {
  const prefix = `${basename(lockPath)}.candidate-`;
  const allCandidates = readdirSync(parent, { withFileTypes: true }).filter(
    (entry) => entry.name.startsWith(prefix) && entry.isDirectory(),
  );
  // Cleanup work is bounded per pass. Any unswept candidate remains a
  // conservative live-installer witness until a later pass proves it dead.
  let hasUnresolvedCandidate = allCandidates.length > MAX_CANDIDATE_SWEEP;
  const candidates = allCandidates.slice(0, MAX_CANDIDATE_SWEEP);
  for (const entry of candidates) {
    const candidatePath = join(parent, entry.name);
    if (candidatePath === ignoredPath) continue;
    let candidate: ReturnType<typeof readOwnerDirectory>;
    try {
      candidate = readOwnerDirectory(candidatePath);
    } catch {
      const creatorPid = Number(
        entry.name.slice(prefix.length).split("-", 1)[0],
      );
      if (!Number.isSafeInteger(creatorPid) || creatorPid <= 0) {
        hasUnresolvedCandidate = true;
        continue;
      }
      try {
        if (
          isOwnerAlive({
            token: "candidate",
            pid: creatorPid,
            processStart: null,
          })
        ) {
          hasUnresolvedCandidate = true;
          continue;
        }
      } catch {
        hasUnresolvedCandidate = true;
        continue;
      }
      rmSync(candidatePath, { recursive: true, force: true });
      fsyncDirectory(parent);
      continue;
    }
    if (!candidate) {
      const creatorPid = Number(
        entry.name.slice(prefix.length).split("-", 1)[0],
      );
      try {
        if (
          !Number.isSafeInteger(creatorPid) ||
          creatorPid <= 0 ||
          isOwnerAlive({
            token: "candidate",
            pid: creatorPid,
            processStart: null,
          })
        ) {
          hasUnresolvedCandidate = true;
          continue;
        }
      } catch {
        hasUnresolvedCandidate = true;
        continue;
      }
      rmSync(candidatePath, { recursive: true, force: true });
      fsyncDirectory(parent);
      continue;
    }
    let alive: boolean;
    try {
      alive = isOwnerAlive(candidate.owner);
    } catch {
      hasUnresolvedCandidate = true;
      continue;
    }
    if (alive) {
      hasUnresolvedCandidate = true;
      continue;
    }
    removeDeadOwner(candidatePath, parent, candidate.ownerPath);
  }
  return hasUnresolvedCandidate;
}

function prepareCandidate(
  lockPath: string,
  parent: string,
  owner: DurableLockOwner,
): string {
  const candidatePath = `${lockPath}.candidate-${owner.pid}-${owner.token}-${randomUUID()}`;
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
    const ownerPath = join(candidatePath, ownerFileName(owner));
    writeFileSync(ownerPath, JSON.stringify(owner), {
      mode: 0o600,
      flag: "wx",
    });
    // Windows rejects FlushFileBuffers for a read-only handle. Use a writable
    // handle for an actual file fsync; only directory fsync is platform-skipped.
    const fd = openSync(ownerPath, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(candidatePath);
    return candidatePath;
  } catch (error) {
    try {
      rmSync(candidatePath, { recursive: true, force: true });
      fsyncDirectory(parent);
    } catch {}
    throw error;
  }
}

/**
 * An inter-process lock represented by a pre-populated directory with a unique
 * owner filename. A stale empty-directory cleanup can remove a replacement in
 * the narrow interval before its owner link is installed. Installation therefore
 * retains its private candidate and verifies the canonical directory identity;
 * losing that race forces a retry and never publishes two owners concurrently.
 */
export function acquireDurableFileLock(
  path: string,
  options: DurableFileLockOptions = {},
): () => void {
  const waitMs = options.waitMs ?? 2_000;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const remainingProbeTimeoutMs = (): number => {
    const remaining = waitMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new Error("Timed out acquiring durable filesystem lock");
    }
    return Math.max(1, Math.ceil(remaining));
  };
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const lockPath = `${path}.lock`;
  const legacyMarkerPath = `${lockPath}.recovery`;
  const legacyOwnersPath = `${lockPath}-owners`;
  const owner =
    options.owner ?? currentDurableLockOwner(remainingProbeTimeoutMs());
  // Validate injected owners before constructing any path from their fields.
  parseOwner(owner);
  const isAlive =
    options.isOwnerAlive ??
    ((candidate: DurableLockOwner) =>
      durableLockOwnerIsAlive(candidate, (pid) =>
        getProcessStart(
          pid,
          process.platform,
          undefined,
          remainingProbeTimeoutMs(),
        ),
      ));
  sweepDeadCandidates(lockPath, parent, isAlive);
  const candidatePath = prepareCandidate(lockPath, parent, owner);
  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        milliseconds,
      ));
  const waitOrThrow = (): void => {
    const remaining = waitMs - (now() - startedAt);
    if (remaining <= 0) {
      throw new Error("Timed out acquiring durable filesystem lock");
    }
    sleep(Math.min(WAIT_SLICE_MS, remaining));
    if (now() - startedAt >= waitMs) {
      throw new Error("Timed out acquiring durable filesystem lock");
    }
  };

  const finishLegacyRecovery = (): "absent" | "blocked" | "cleaned" => {
    let marked: DurableLockOwner;
    try {
      marked = readOwnerFile(legacyMarkerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
      throw error;
    }
    if (isAlive(marked)) return "blocked";
    if (sameFile(lockPath, legacyMarkerPath)) {
      unlinkSync(lockPath);
      fsyncDirectory(parent);
    }
    const legacyOwnerPath = join(
      legacyOwnersPath,
      `${marked.pid}-${marked.token}.json`,
    );
    if (sameFile(legacyOwnerPath, legacyMarkerPath)) {
      unlinkSync(legacyOwnerPath);
      fsyncDirectory(legacyOwnersPath);
    }
    unlinkSync(legacyMarkerPath);
    fsyncDirectory(parent);
    return "cleaned";
  };

  let consecutiveProgress = 0;
  const retryAfterProgress = (): void => {
    consecutiveProgress += 1;
    // One immediate retry makes cleanup useful even with a tiny portable
    // deadline. Repeated replacement churn still yields and consumes the same
    // total deadline instead of spinning synchronously.
    if (consecutiveProgress > 1) {
      consecutiveProgress = 0;
      waitOrThrow();
    }
  };
  try {
    while (true) {
      const legacyRecovery = finishLegacyRecovery();
      if (legacyRecovery !== "absent") {
        if (legacyRecovery === "cleaned") retryAfterProgress();
        else waitOrThrow();
        continue;
      }
      try {
        if (!installCandidateDirectory(candidatePath, lockPath, options)) {
          waitOrThrow();
          continue;
        }
        fsyncDirectory(parent);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          code !== "EEXIST" &&
          code !== "ENOTEMPTY" &&
          code !== "EPERM" &&
          code !== "EACCES"
        ) {
          throw error;
        }
        // Permanent policy denials must consume the same bounded wait budget as
        // an occupied lock; otherwise mkdir/link/rmdir can spin synchronously.
        if (code === "EPERM" || code === "EACCES") {
          waitOrThrow();
          continue;
        }
      }

      let incumbent: ReturnType<typeof readOwnerDirectory>;
      try {
        incumbent = readOwnerDirectory(lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          waitOrThrow();
          continue;
        }
        if (code === "ENOTDIR") {
          const legacyOwner = readOwnerFile(lockPath);
          if (isAlive(legacyOwner)) {
            waitOrThrow();
            continue;
          }
          try {
            linkSync(lockPath, legacyMarkerPath);
            fsyncDirectory(parent);
          } catch (linkError) {
            const linkCode = (linkError as NodeJS.ErrnoException).code;
            if (linkCode !== "EEXIST" && linkCode !== "ENOENT") {
              throw linkError;
            }
          }
          waitOrThrow();
          continue;
        }
        throw error; // Corrupt or multiple-owner directories fail closed.
      }
      if (incumbent === null) {
        const emptyDirectoryIdentity = pathIdentity(lockPath);
        let cleaned = false;
        if (emptyDirectoryIdentity) {
          if (!sweepDeadCandidates(lockPath, parent, isAlive, candidatePath)) {
            options.beforeEmptyCleanup?.(lockPath);
            cleaned = removeDirectoryIfEmpty(
              lockPath,
              parent,
              emptyDirectoryIdentity,
            );
          }
        }
        if (cleaned) retryAfterProgress();
        else waitOrThrow();
        continue;
      }
      if (isAlive(incumbent.owner)) {
        waitOrThrow();
        continue;
      }
      if (
        removeDeadOwner(
          lockPath,
          parent,
          incumbent.ownerPath,
          options.afterOwnerUnlink,
        )
      ) {
        retryAfterProgress();
      } else {
        waitOrThrow();
      }
    }
  } catch (error) {
    // Installation can throw after either canonical hardlink is published.
    // Each cleanup is independent so a failed unlink/fsync of `.installing`
    // cannot strand the stable owner filename for this live process.
    const candidateOwner = join(candidatePath, ownerFileName(owner));
    const installingOwner = join(lockPath, INSTALLING_OWNER_NAME);
    try {
      if (sameFile(candidateOwner, installingOwner)) {
        unlinkSync(installingOwner);
        fsyncDirectory(lockPath);
      }
    } catch {}
    try {
      removeDeadOwner(lockPath, parent, join(lockPath, ownerFileName(owner)));
    } catch {}
    try {
      rmSync(candidatePath, { recursive: true, force: true });
      fsyncDirectory(parent);
    } catch {}
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    const ownPath = join(lockPath, ownerFileName(owner));
    const directoryIdentity = pathIdentity(lockPath);
    let removedOwnFile = false;
    try {
      unlinkSync(ownPath);
      removedOwnFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (removedOwnFile) {
      options.afterOwnerUnlink?.(lockPath);
      if (directoryIdentity) {
        removeDirectoryIfEmpty(lockPath, parent, directoryIdentity);
      }
    }
    released = true;
  };
}
