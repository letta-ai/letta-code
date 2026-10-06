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
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_OWNER_BYTES = 4096;
const WAIT_SLICE_MS = 5;

export type DurableLockOwner = {
  token: string;
  pid: number;
  processStart: string | null;
};

export type DurableFileLockOptions = {
  waitMs?: number;
  owner?: DurableLockOwner;
  isOwnerAlive?: (owner: DurableLockOwner) => boolean;
  /** Deterministic race injection used by the lock's adversarial tests. */
  beforeExactUnlink?: (path: string) => void;
};

type FileIdentity = { dev: number; ino: number };
type ProcessStartCommand = (
  executable: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => string;

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
  return {
    token: randomUUID(),
    pid: process.pid,
    processStart: getProcessStart(process.pid),
  };
}

export function durableLockOwnerIsAlive(
  owner: DurableLockOwner,
  readStart: (pid: number) => string | null = getProcessStart,
): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const actualStart = readStart(owner.pid);
  // Unknown identity fails closed: never evict a reachable process unless both
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

function readOwner(path: string): {
  owner: DurableLockOwner;
  identity: FileIdentity;
  links: number;
  close: () => void;
} {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) {
      throw new Error("Invalid durable lock owner file");
    }
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read !== bytes.length) throw new Error("Short durable lock owner read");
    return {
      owner: parseOwner(JSON.parse(bytes.toString("utf8"))),
      identity: { dev: stat.dev, ino: stat.ino },
      links: stat.nlink,
      // Holding this descriptor pins the inode, preventing a removed M0 inode
      // number from being recycled for M1 during exact-path revalidation.
      close: () => closeSync(fd),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function identityAt(path: string): FileIdentity | null {
  try {
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function identitiesEqual(
  first: FileIdentity | null,
  second: FileIdentity,
): boolean {
  return first?.dev === second.dev && first.ino === second.ino;
}

function unlinkExact(
  path: string,
  directory: string,
  expected: FileIdentity,
  before?: (path: string) => void,
): boolean {
  before?.(path);
  if (!identitiesEqual(identityAt(path), expected)) return false;
  unlinkSync(path);
  fsyncDirectory(directory);
  return true;
}

function removeOwnersDirectory(ownersPath: string, parent: string): void {
  try {
    rmdirSync(ownersPath);
    fsyncDirectory(parent);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

/**
 * An inter-process lock whose canonical path and recovery marker are hard links
 * to an immutable owner inode. The marker closes the read-then-unlink race: all
 * acquisitions honor it, and a crashed recoverer leaves enough identity behind
 * for the next contender to finish removing only the exact dead incumbent.
 */
export function acquireDurableFileLock(
  path: string,
  options: DurableFileLockOptions = {},
): () => void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const lockPath = `${path}.lock`;
  const markerPath = `${lockPath}.recovery`;
  const ownersPath = `${lockPath}-owners`;
  mkdirSync(ownersPath, { recursive: true, mode: 0o700 });
  chmodSync(ownersPath, 0o700);

  const owner = options.owner ?? currentDurableLockOwner();
  const ownerPath = join(ownersPath, `${owner.pid}-${owner.token}.json`);
  writeFileSync(ownerPath, JSON.stringify(owner), { mode: 0o600, flag: "wx" });
  // Windows rejects FlushFileBuffers for a read-only handle. Use a writable
  // handle for an actual file fsync; only directory fsync is platform-skipped.
  const ownerFd = openSync(ownerPath, "r+");
  let ownerIdentity: FileIdentity;
  try {
    ownerIdentity = (() => {
      const stat = fstatSync(ownerFd);
      return { dev: stat.dev, ino: stat.ino };
    })();
    fsyncSync(ownerFd);
  } finally {
    closeSync(ownerFd);
  }
  fsyncDirectory(ownersPath);

  const isAlive = options.isOwnerAlive ?? durableLockOwnerIsAlive;
  // Reclaim valid orphan candidates left by crashes before acquisition or after
  // canonical release. Files still linked as a lock/marker have nlink > 1 and
  // are handled only through the exact-inode marker protocol below.
  let sweptOwners = false;
  for (const name of readdirSync(ownersPath)) {
    const candidate = join(ownersPath, name);
    if (candidate === ownerPath) continue;
    let candidateOwner: ReturnType<typeof readOwner>;
    try {
      candidateOwner = readOwner(candidate);
    } catch {
      continue; // Unknown/corrupt files fail closed.
    }
    try {
      if (isAlive(candidateOwner.owner) || candidateOwner.links !== 1) continue;
      try {
        sweptOwners =
          unlinkExact(
            candidate,
            ownersPath,
            candidateOwner.identity,
            options.beforeExactUnlink,
          ) || sweptOwners;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      candidateOwner.close();
    }
  }
  if (sweptOwners) fsyncDirectory(ownersPath);

  const waitMs = options.waitMs ?? 2_000;
  const startedAt = Date.now();
  const waitOrThrow = (cause?: unknown): void => {
    if (Date.now() - startedAt >= waitMs) {
      if (cause instanceof Error) throw cause;
      throw new Error("Timed out acquiring durable filesystem lock");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_SLICE_MS);
  };

  const finishRecoveryMarker = (): boolean => {
    let marked: ReturnType<typeof readOwner>;
    try {
      marked = readOwner(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error; // Corrupt markers fail closed.
    }
    try {
      if (isAlive(marked.owner)) {
        waitOrThrow();
        return true;
      }
      // Every removal revalidates the inode pinned by readOwner. A concurrent
      // recoverer may finish M0 and a live contender may create M1 between any
      // two steps; stale M0 work must then become a no-op rather than unlink M1.
      unlinkExact(lockPath, parent, marked.identity, options.beforeExactUnlink);
      const markedOwnerPath = join(
        ownersPath,
        `${marked.owner.pid}-${marked.owner.token}.json`,
      );
      unlinkExact(
        markedOwnerPath,
        ownersPath,
        marked.identity,
        options.beforeExactUnlink,
      );
      unlinkExact(
        markerPath,
        parent,
        marked.identity,
        options.beforeExactUnlink,
      );
      removeOwnersDirectory(ownersPath, parent);
      return true;
    } finally {
      marked.close();
    }
  };

  try {
    while (true) {
      if (finishRecoveryMarker()) continue;
      try {
        linkSync(ownerPath, lockPath);
        fsyncDirectory(parent);
        // A reclaimer may have linked a predecessor/replacement into the marker
        // after our initial check. Never enter the critical section until it is
        // gone; if it pinned us, it will observe this live owner and wait.
        try {
          lstatSync(markerPath);
          unlinkExact(
            lockPath,
            parent,
            ownerIdentity,
            options.beforeExactUnlink,
          );
          waitOrThrow();
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }

      const incumbent = readOwner(lockPath); // Corrupt canonical locks fail closed.
      try {
        if (isAlive(incumbent.owner)) {
          waitOrThrow();
          continue;
        }
        try {
          // If canonical changed first, the marker pins the replacement and its
          // liveness is re-evaluated by finishRecoveryMarker.
          linkSync(lockPath, markerPath);
          fsyncDirectory(parent);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST" && code !== "ENOENT") throw error;
        }
      } finally {
        incumbent.close();
      }
    }
  } catch (error) {
    try {
      unlinkExact(
        ownerPath,
        ownersPath,
        ownerIdentity,
        options.beforeExactUnlink,
      );
      removeOwnersDirectory(ownersPath, parent);
    } catch {}
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    try {
      linkSync(lockPath, markerPath);
      fsyncDirectory(parent);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        const markerIdentity = identityAt(markerPath);
        if (markerIdentity && !identitiesEqual(markerIdentity, ownerIdentity)) {
          throw new Error("Refusing to release a replacement recovery marker");
        }
        if (
          markerIdentity &&
          !unlinkExact(
            markerPath,
            parent,
            ownerIdentity,
            options.beforeExactUnlink,
          ) &&
          identityAt(markerPath) !== null
        ) {
          throw new Error("Refusing to release a changed recovery marker");
        }
        unlinkExact(
          ownerPath,
          ownersPath,
          ownerIdentity,
          options.beforeExactUnlink,
        );
        removeOwnersDirectory(ownersPath, parent);
        released = true;
        return;
      }
      // A prior failed release may already have installed our exact marker.
      if (code !== "EEXIST") throw error;
    }
    // Any failure below deliberately leaves the marker behind. It blocks new
    // mutations and is safely retryable; released is set only after every exact
    // path has either been removed or proven absent.
    if (!identitiesEqual(identityAt(markerPath), ownerIdentity)) {
      throw new Error("Refusing to release a replacement durable lock");
    }
    unlinkExact(lockPath, parent, ownerIdentity, options.beforeExactUnlink);
    if (
      !unlinkExact(
        markerPath,
        parent,
        ownerIdentity,
        options.beforeExactUnlink,
      ) &&
      identityAt(markerPath) !== null
    ) {
      throw new Error("Refusing to release a changed recovery marker");
    }
    unlinkExact(
      ownerPath,
      ownersPath,
      ownerIdentity,
      options.beforeExactUnlink,
    );
    removeOwnersDirectory(ownersPath, parent);
    released = true;
  };
}
