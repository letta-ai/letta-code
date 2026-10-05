import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
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
};

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function getProcessStart(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;
    return stat.slice(closeParen + 2).split(" ")[19] ?? null;
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

export function durableLockOwnerIsAlive(owner: DurableLockOwner): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  const actualStart = getProcessStart(owner.pid);
  // If the platform cannot supply a start identity, conservatively treat a
  // reachable PID as live. When both identities exist, PID reuse is detectable.
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

function readOwner(path: string): DurableLockOwner {
  const fd = openSync(path, "r");
  try {
    const stat = lstatSync(path);
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

function sameInode(first: string, second: string): boolean {
  try {
    const a = lstatSync(first);
    const b = lstatSync(second);
    return a.dev === b.dev && a.ino === b.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function unlinkAndSync(path: string, directory: string): void {
  unlinkSync(path);
  fsyncDirectory(directory);
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
  const ownerFd = openSync(ownerPath, "r");
  try {
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
    let candidateOwner: DurableLockOwner;
    try {
      candidateOwner = readOwner(candidate);
    } catch {
      continue; // Unknown/corrupt files fail closed.
    }
    if (isAlive(candidateOwner)) continue;
    try {
      if (lstatSync(candidate).nlink !== 1) continue;
      unlinkSync(candidate);
      sweptOwners = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
    let marked: DurableLockOwner;
    try {
      marked = readOwner(markerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error; // Corrupt markers fail closed.
    }
    if (isAlive(marked)) {
      waitOrThrow();
      return true;
    }
    if (sameInode(lockPath, markerPath)) unlinkAndSync(lockPath, parent);
    // With canonical absent, no replacement can appear until this marker is
    // removed because every conforming acquisition checks the marker.
    const markedOwnerPath = join(
      ownersPath,
      `${marked.pid}-${marked.token}.json`,
    );
    if (sameInode(markedOwnerPath, markerPath)) {
      unlinkAndSync(markedOwnerPath, ownersPath);
    }
    unlinkAndSync(markerPath, parent);
    return true;
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
          if (sameInode(lockPath, ownerPath)) unlinkAndSync(lockPath, parent);
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
      if (isAlive(incumbent)) {
        waitOrThrow();
        continue;
      }
      try {
        // This pins exactly the inode just observed. If canonical changed first,
        // the marker pins the replacement and its liveness is re-evaluated.
        linkSync(lockPath, markerPath);
        fsyncDirectory(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOENT") throw error;
      }
    }
  } catch (error) {
    try {
      unlinkAndSync(ownerPath, ownersPath);
    } catch {}
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      linkSync(lockPath, markerPath);
      fsyncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    // Any failure below deliberately leaves the marker behind. It blocks new
    // mutations and is safely takeover-able after this exact owner dies.
    if (!sameInode(markerPath, ownerPath)) {
      throw new Error("Refusing to release a replacement durable lock");
    }
    if (sameInode(lockPath, ownerPath)) unlinkAndSync(lockPath, parent);
    unlinkAndSync(markerPath, parent);
    try {
      unlinkAndSync(ownerPath, ownersPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
}
