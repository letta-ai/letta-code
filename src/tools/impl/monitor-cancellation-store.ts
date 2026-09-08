import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AgentRuntimeScope } from "@/types/runtime-scope";

export interface MonitorCancellationReceipt {
  version: 1;
  processId: string;
  noticeId: string;
  runtime: AgentRuntimeScope;
  description: string;
  state: "intent" | "stopped" | "uncertain" | "failed" | "delivered";
  createdAt: number;
  /** Prevent another listener from recovering an intent while its writer lives. */
  creatorPid?: number;
}

/** Cancellation-only receipts. Kept after delivery so retries cannot notify twice. */
export class MonitorCancellationStore {
  constructor(readonly directory: string) {}

  private path(processId: string): string {
    return join(
      this.directory,
      `${createHash("sha256").update(processId).digest("hex")}.json`,
    );
  }

  read(processId: string): MonitorCancellationReceipt | null {
    try {
      return this.parse(readFileSync(this.path(processId), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  list(): MonitorCancellationReceipt[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return names
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
      .map((name) =>
        this.parse(readFileSync(join(this.directory, name), "utf8")),
      );
  }

  write(receipt: MonitorCancellationReceipt): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(receipt.processId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(receipt));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, path);
      // Windows does not support opening directories for fsync.
      if (process.platform !== "win32") {
        const directoryFd = openSync(this.directory, "r");
        try {
          fsyncSync(directoryFd);
        } finally {
          closeSync(directoryFd);
        }
      }
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        /* already renamed */
      }
    }
  }

  private parse(text: string): MonitorCancellationReceipt {
    const row = JSON.parse(text) as MonitorCancellationReceipt;
    if (
      row.version !== 1 ||
      typeof row.processId !== "string" ||
      typeof row.noticeId !== "string" ||
      typeof row.description !== "string" ||
      typeof row.runtime?.agent_id !== "string" ||
      typeof row.runtime?.conversation_id !== "string" ||
      (row.runtime.acting_user_id !== undefined &&
        typeof row.runtime.acting_user_id !== "string") ||
      !["intent", "stopped", "uncertain", "failed", "delivered"].includes(
        row.state,
      ) ||
      !Number.isFinite(row.createdAt) ||
      (row.creatorPid !== undefined &&
        (!Number.isSafeInteger(row.creatorPid) || row.creatorPid <= 0))
    )
      throw new Error("Invalid Monitor cancellation receipt");
    return row;
  }
}
