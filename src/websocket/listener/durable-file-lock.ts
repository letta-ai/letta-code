import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const MAX_OWNER_BYTES = 4096;
const WAIT_SLICE_MS = 5;
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
};

type ProcessStartCommand = (
  executable: string,
  args: string[],
  options?: { env?: NodeJS.ProcessEnv },
) => string;
type ProcessProbe = (pid: number) => void;

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
  if (names.length !== 1) {
    throw new Error("Invalid durable lock owner directory");
  }
  const ownerPath = join(lockPath, names[0] as string);
  const fd = openSync(ownerPath, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_OWNER_BYTES) {
      throw new Error("Invalid durable lock owner file");
    }
    const bytes = Buffer.alloc(stat.size);
    const read = readSync(fd, bytes, 0, bytes.length, 0);
    if (read !== bytes.length) throw new Error("Short durable lock owner read");
    const owner = parseOwner(JSON.parse(bytes.toString("utf8")));
    if (names[0] !== ownerFileName(owner)) {
      throw new Error("Invalid durable lock owner filename");
    }
    return { owner, ownerPath };
  } finally {
    closeSync(fd);
  }
}

function removeDirectoryIfEmpty(path: string, parent: string): boolean {
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
  try {
    unlinkSync(ownerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // The unique filename is the identity check. If another contender atomically
  // installs M1 over this now-empty M0 directory, it has a different populated
  // filename: this stale rmdir cannot remove it.
  afterOwnerUnlink?.(lockPath);
  removeDirectoryIfEmpty(lockPath, parent);
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
 * An inter-process lock represented by an atomically installed, pre-populated
 * directory. Each incarnation has a unique owner filename. Recovery unlinks only
 * that filename before removing the empty directory, so stale cleanup cannot
 * unlink or rmdir an atomically installed replacement.
 */
export function acquireDurableFileLock(
  path: string,
  options: DurableFileLockOptions = {},
): () => void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const lockPath = `${path}.lock`;
  const owner = options.owner ?? currentDurableLockOwner();
  // Validate injected owners before constructing any path from their fields.
  parseOwner(owner);
  const candidatePath = prepareCandidate(lockPath, parent, owner);
  const isAlive = options.isOwnerAlive ?? durableLockOwnerIsAlive;
  const waitMs = options.waitMs ?? 2_000;
  const startedAt = Date.now();
  const waitOrThrow = (): void => {
    if (Date.now() - startedAt >= waitMs) {
      throw new Error("Timed out acquiring durable filesystem lock");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_SLICE_MS);
  };

  let installed = false;
  try {
    while (true) {
      try {
        renameSync(candidatePath, lockPath);
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
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          waitOrThrow();
          continue;
        }
        throw error; // Corrupt or multiple-owner directories fail closed.
      }
      if (incumbent === null) {
        removeDirectoryIfEmpty(lockPath, parent);
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
    let removedOwnFile = false;
    try {
      unlinkSync(ownPath);
      removedOwnFile = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (removedOwnFile) {
      options.afterOwnerUnlink?.(lockPath);
      removeDirectoryIfEmpty(lockPath, parent);
    }
    released = true;
  };
}
