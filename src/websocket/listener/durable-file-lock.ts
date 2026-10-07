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
};

type ProcessStartCommand = (
  executable: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => string;
type ProcessProbe = (pid: number) => void;

function installCandidateDirectory(
  candidatePath: string,
  lockPath: string,
  afterMkdir?: (lockPath: string) => void,
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
  afterMkdir?.(lockPath);
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
  fsyncDirectory(lockPath);
  unlinkSync(installingOwnerPath);
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
        ? run("powershell", [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`,
          ])
        : run("ps", ["-o", "lstart=", "-p", String(pid)], {
            env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
          });
    return started.trim() || null;
  } catch {
    return null;
  }
}

export function currentDurableLockOwner(): DurableLockOwner {
  if (cachedCurrentProcessStart === undefined) {
    cachedCurrentProcessStart = getProcessStart(process.pid);
  }
  return {
    token: randomUUID(),
    pid: process.pid,
    processStart: cachedCurrentProcessStart,
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
): void {
  const directoryIdentity = pathIdentity(lockPath);
  if (!directoryIdentity) return;
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The unique filename is the identity check. If another contender atomically
  // installs M1 over this now-empty M0 directory, it has a different populated
  // filename: this stale rmdir cannot remove it.
  afterOwnerUnlink?.(lockPath);
  removeDirectoryIfEmpty(lockPath, parent, directoryIdentity);
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
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const lockPath = `${path}.lock`;
  const legacyMarkerPath = `${lockPath}.recovery`;
  const legacyOwnersPath = `${lockPath}-owners`;
  const owner = options.owner ?? currentDurableLockOwner();
  // Validate injected owners before constructing any path from their fields.
  parseOwner(owner);
  const isAlive = options.isOwnerAlive ?? durableLockOwnerIsAlive;
  sweepDeadCandidates(lockPath, parent, isAlive);
  const candidatePath = prepareCandidate(lockPath, parent, owner);
  const waitMs = options.waitMs ?? 2_000;
  const startedAt = Date.now();
  const waitOrThrow = (): void => {
    if (Date.now() - startedAt >= waitMs) {
      throw new Error("Timed out acquiring durable filesystem lock");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_SLICE_MS);
  };

  const finishLegacyRecovery = (): boolean => {
    let marked: DurableLockOwner;
    try {
      marked = readOwnerFile(legacyMarkerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (isAlive(marked)) {
      waitOrThrow();
      return true;
    }
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
    return true;
  };

  let installed = false;
  try {
    while (true) {
      if (finishLegacyRecovery()) continue;
      try {
        if (
          !installCandidateDirectory(
            candidatePath,
            lockPath,
            options.afterInstallMkdir,
          )
        ) {
          continue;
        }
        installed = true;
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
          continue;
        }
        throw error; // Corrupt or multiple-owner directories fail closed.
      }
      if (incumbent === null) {
        const emptyDirectoryIdentity = pathIdentity(lockPath);
        if (!emptyDirectoryIdentity) continue;
        if (sweepDeadCandidates(lockPath, parent, isAlive, candidatePath)) {
          waitOrThrow();
        } else {
          removeDirectoryIfEmpty(lockPath, parent, emptyDirectoryIdentity);
        }
        continue;
      }
      if (isAlive(incumbent.owner)) {
        waitOrThrow();
        continue;
      }
      removeDeadOwner(
        lockPath,
        parent,
        incumbent.ownerPath,
        options.afterOwnerUnlink,
      );
    }
  } catch (error) {
    try {
      if (installed) {
        removeDeadOwner(lockPath, parent, join(lockPath, ownerFileName(owner)));
      } else {
        rmSync(candidatePath, { recursive: true, force: true });
        fsyncDirectory(parent);
      }
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
