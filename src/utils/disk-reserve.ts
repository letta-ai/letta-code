import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isManagedCloudRuntime } from "@/managed-cloud-runtime";

export const DISK_RESERVE_BYTES = 512 * 1024 ** 2;

function device(path: string): number {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return statSync(candidate).dev;
}

/** One reserve per listener state volume, shared across process restarts. */
export class DiskReserve {
  constructor(
    readonly path: string,
    private readonly notify: () => void,
    private readonly bytes = DISK_RESERVE_BYTES,
  ) {}

  release(writePath: string): boolean {
    try {
      if (device(writePath) !== device(this.path)) return false;
      unlinkSync(this.path);
      try {
        this.notify();
      } catch {}
      return true;
    } catch {
      return false;
    }
  }

  update(sample: {
    path: string;
    totalBytes: number;
    availableBytes: number;
  }): boolean {
    try {
      if (device(sample.path) !== device(this.path)) return false;
      const used = 1 - sample.availableBytes / sample.totalBytes;
      if (used >= 0.95) {
        return this.release(sample.path);
      }
      // Keep both the percentage and absolute low-space thresholds clear.
      if (
        used >= 0.9 ||
        sample.availableBytes - this.bytes <= sample.totalBytes * 0.1 ||
        sample.availableBytes - this.bytes < 1024 ** 3 ||
        existsSync(this.path)
      )
        return false;
      mkdirSync(dirname(this.path), { recursive: true });
      const fd = openSync(this.path, "wx", 0o600);
      try {
        // Writing every byte allocates real blocks, unlike truncate.
        const chunk = Buffer.alloc(Math.min(this.bytes, 1024 ** 2));
        let remaining = this.bytes;
        while (remaining > 0) {
          const written = writeSync(
            fd,
            chunk,
            0,
            Math.min(remaining, chunk.length),
          );
          if (written === 0)
            throw new Error("Reserve allocation made no progress");
          remaining -= written;
        }
      } catch {
        try {
          unlinkSync(this.path);
        } catch {}
      } finally {
        closeSync(fd);
      }
    } catch {}
    return false;
  }
}

let activeReserve: DiskReserve | null = null;

export function setDiskReserve(reserve: DiskReserve | null): void {
  activeReserve = reserve;
}

export function updateDiskReserve(sample: {
  path: string;
  totalBytes: number;
  availableBytes: number;
}): boolean {
  return activeReserve?.update(sample) ?? false;
}

/** Release same-volume emergency space and retry an ENOSPC exactly once. */
export function withDiskReserveRetry<T>(path: string, operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (
      isManagedCloudRuntime() &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOSPC"
    ) {
      activeReserve?.release(path);
      return operation();
    }
    throw error;
  }
}
