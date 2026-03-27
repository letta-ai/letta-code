/**
 * Persistent cron task storage backed by ~/.letta/crons.json.
 *
 * Provides CRUD operations with:
 * - Atomic writes (temp file + rename)
 * - mkdir-based advisory locking for read-modify-write cycles
 * - Scheduler ownership lease (PID + random token)
 * - Garbage collection for terminal tasks older than 24 hours
 */

import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { estimatePeriodMs } from "./parseInterval";

// ── Types ───────────────────────────────────────────────────────────

export type CronTaskStatus = "active" | "fired" | "missed" | "cancelled";
export type CancelReason = "conversation_not_found" | "expired";

export interface SchedulerOwner {
  pid: number;
  token: string;
  started_at: string; // ISO
}

export interface CronTask {
  // Identity
  id: string;
  agent_id: string;
  conversation_id: string; // defaults to "default"

  // Metadata
  name: string;
  description: string;

  // Schedule
  cron: string;
  timezone: string; // IANA
  recurring: boolean;

  // Content
  prompt: string;

  // Lifecycle
  status: CronTaskStatus;
  created_at: string; // ISO
  expires_at: string | null; // 3-day TTL for recurring; null for one-shot
  last_fired_at: string | null;
  fire_count: number;
  cancel_reason: CancelReason | null;
  jitter_offset_ms: number;

  // One-shot specific
  scheduled_for: string | null; // ISO UTC
  fired_at: string | null;
  missed_at: string | null;
}

interface CronFileData {
  version: 1;
  scheduler_owner: SchedulerOwner | null;
  tasks: CronTask[];
}

// ── Constants ───────────────────────────────────────────────────────

const CRON_FILE_NAME = "crons.json";
const LOCK_DIR_NAME = "crons.lock";
const LOCK_TOKEN_FILE = "owner.json";
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 50;
const LOCK_STALE_AGE_MS = 30_000;
const MAX_ACTIVE_TASKS_PER_AGENT = 50;
const TASK_ID_BYTES = 4; // 8 hex chars
const DEFAULT_TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
const GC_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// ── Paths ───────────────────────────────────────────────────────────

function getLettaDir(): string {
  if (process.env.LETTA_HOME) return process.env.LETTA_HOME;
  return join(process.env.HOME ?? process.env.USERPROFILE ?? "~", ".letta");
}

function getCronFilePath(): string {
  return join(getLettaDir(), CRON_FILE_NAME);
}

function getLockDirPath(): string {
  return join(getLettaDir(), LOCK_DIR_NAME);
}

// ── File I/O ────────────────────────────────────────────────────────

function emptyFile(): CronFileData {
  return { version: 1, scheduler_owner: null, tasks: [] };
}

export function readCronFile(): CronFileData {
  const path = getCronFilePath();
  if (!existsSync(path)) return emptyFile();
  try {
    const raw = readFileSync(path, "utf-8");
    const data = JSON.parse(raw) as CronFileData;
    if (data.version !== 1) return emptyFile();
    return data;
  } catch {
    return emptyFile();
  }
}

function writeCronFile(data: CronFileData): void {
  const path = getCronFilePath();
  const dir = getLettaDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { flush: true });
  renameSync(tmp, path);
}

// ── Locking ─────────────────────────────────────────────────────────

interface LockOwner {
  pid: number;
  token: string;
  acquired_at: number;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLockOwner(lockDir: string): LockOwner | null {
  try {
    const raw = readFileSync(join(lockDir, LOCK_TOKEN_FILE), "utf-8");
    return JSON.parse(raw) as LockOwner;
  } catch {
    return null;
  }
}

function writeLockOwner(lockDir: string, owner: LockOwner): void {
  writeFileSync(join(lockDir, LOCK_TOKEN_FILE), JSON.stringify(owner));
}

function isLockStale(lockDir: string): boolean {
  const owner = readLockOwner(lockDir);
  if (!owner) {
    // No owner file → consider stale if dir exists and is old
    try {
      const stat = statSync(lockDir);
      return Date.now() - stat.mtimeMs > LOCK_STALE_AGE_MS;
    } catch {
      return true;
    }
  }

  // Steal only if PID is dead AND lock is older than threshold
  const pidDead = !isProcessAlive(owner.pid);
  const isOld = Date.now() - owner.acquired_at > LOCK_STALE_AGE_MS;
  return pidDead && isOld;
}

function stealLock(lockDir: string): void {
  try {
    rmdirSync(lockDir, { recursive: true } as Parameters<typeof rmdirSync>[1]);
  } catch {
    // Best effort
  }
}

export interface LockHandle {
  release(): void;
}

/**
 * Acquire the crons.lock advisory lock.
 * Throws if unable to acquire within LOCK_TIMEOUT_MS.
 */
export function acquireLock(): LockHandle {
  const lockDir = getLockDirPath();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  const token = randomBytes(4).toString("hex");

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir, { recursive: false });
      // Success — we own the lock
      const owner: LockOwner = {
        pid: process.pid,
        token,
        acquired_at: Date.now(),
      };
      writeLockOwner(lockDir, owner);
      return {
        release() {
          try {
            // Verify we still own it before releasing
            const current = readLockOwner(lockDir);
            if (current && current.token === token) {
              rmdirSync(lockDir, { recursive: true } as Parameters<
                typeof rmdirSync
              >[1]);
            }
          } catch {
            // Best effort
          }
        },
      };
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Lock held — check if stale
        if (isLockStale(lockDir)) {
          stealLock(lockDir);
          continue; // Retry immediately
        }
        // Wait and retry
        const sleepMs = Math.min(
          LOCK_RETRY_MS + Math.random() * LOCK_RETRY_MS,
          deadline - Date.now(),
        );
        if (sleepMs > 0) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
        }
        continue;
      }
      throw err; // Unexpected error
    }
  }

  throw new Error("Failed to acquire crons.lock — timed out after 5s");
}

/**
 * Execute a callback while holding the lock.
 * Lock is released in a finally block.
 */
export function withLock<T>(fn: () => T): T {
  const lock = acquireLock();
  try {
    return fn();
  } finally {
    lock.release();
  }
}

// ── Task ID ─────────────────────────────────────────────────────────

function generateTaskId(): string {
  return randomBytes(TASK_ID_BYTES).toString("hex");
}

// ── Jitter ──────────────────────────────────────────────────────────

function simpleHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const char = s.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return Math.abs(hash);
}

/**
 * Compute jitter offset for a task.
 * - Recurring: late jitter, bounded by min(10% of period, 15 min)
 * - One-shot at :00/:30: early jitter up to 90s (negative offset)
 * - Other one-shots: no jitter (0)
 */
export function computeJitter(
  taskId: string,
  cron: string,
  recurring: boolean,
  scheduledFor: Date | null,
  createdAt: Date,
): number {
  if (recurring) {
    const periodMs = estimatePeriodMs(cron);
    if (periodMs <= 0) return 0;
    // Cap recurring jitter to < 60s (one tick interval). The scheduler
    // evaluates once per minute, so cross-minute jitter would be ignored.
    const maxJitter = Math.min(periodMs * 0.1, 59_999);
    return simpleHash(taskId) % Math.max(1, Math.floor(maxJitter));
  }

  // One-shot
  if (!scheduledFor) return 0;

  const min = scheduledFor.getMinutes();
  if (min === 0 || min === 30) {
    const offset = -(simpleHash(taskId) % 90_000);
    // Don't fire before creation time
    if (scheduledFor.getTime() + offset < createdAt.getTime()) return 0;
    return offset;
  }

  return 0;
}

// ── CRUD ────────────────────────────────────────────────────────────

export interface AddTaskInput {
  agent_id: string;
  conversation_id?: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string;
  recurring: boolean;
  prompt: string;
  scheduled_for?: Date; // for one-shots
}

export interface AddTaskResult {
  task: CronTask;
  warning?: string;
}

/**
 * Add a new cron task. Acquires the lock internally.
 */
export function addTask(input: AddTaskInput): AddTaskResult {
  return withLock(() => {
    const data = readCronFile();
    const agentId = input.agent_id;
    const conversationId = input.conversation_id ?? "default";

    // Check per-agent active limit
    const activeCount = data.tasks.filter(
      (t) => t.agent_id === agentId && t.status === "active",
    ).length;
    if (activeCount >= MAX_ACTIVE_TASKS_PER_AGENT) {
      throw new Error(
        `Agent ${agentId} has ${activeCount} active tasks (max ${MAX_ACTIVE_TASKS_PER_AGENT}). Delete some before adding more.`,
      );
    }

    const now = new Date();
    const taskId = generateTaskId();
    const timezone =
      input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

    const task: CronTask = {
      id: taskId,
      agent_id: agentId,
      conversation_id: conversationId,
      name: input.name,
      description: input.description,
      cron: input.cron,
      timezone,
      recurring: input.recurring,
      prompt: input.prompt,
      status: "active",
      created_at: now.toISOString(),
      expires_at: input.recurring
        ? new Date(now.getTime() + DEFAULT_TTL_MS).toISOString()
        : null,
      last_fired_at: null,
      fire_count: 0,
      cancel_reason: null,
      jitter_offset_ms: computeJitter(
        taskId,
        input.cron,
        input.recurring,
        input.scheduled_for ?? null,
        now,
      ),
      scheduled_for: input.scheduled_for?.toISOString() ?? null,
      fired_at: null,
      missed_at: null,
    };

    data.tasks.push(task);
    writeCronFile(data);

    // Check if a scheduler is running
    let warning: string | undefined;
    if (!data.scheduler_owner || !isProcessAlive(data.scheduler_owner.pid)) {
      warning =
        "No letta server is currently running. This task will only execute when a WS listener is active.";
    }

    return { task, warning };
  });
}

/**
 * List tasks, optionally filtered by agent and/or conversation.
 */
export function listTasks(filters?: {
  agent_id?: string;
  conversation_id?: string;
}): CronTask[] {
  const data = readCronFile();
  let tasks = data.tasks;
  if (filters?.agent_id) {
    tasks = tasks.filter((t) => t.agent_id === filters.agent_id);
  }
  if (filters?.conversation_id) {
    tasks = tasks.filter((t) => t.conversation_id === filters.conversation_id);
  }
  return tasks;
}

/**
 * Get a single task by ID.
 */
export function getTask(taskId: string): CronTask | null {
  const data = readCronFile();
  return data.tasks.find((t) => t.id === taskId) ?? null;
}

/**
 * Delete a task by ID. Physical removal from the file.
 * Acquires the lock internally.
 * Returns true if found and removed, false if not found.
 */
export function deleteTask(taskId: string): boolean {
  return withLock(() => {
    const data = readCronFile();
    const idx = data.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return false;
    data.tasks.splice(idx, 1);
    writeCronFile(data);
    return true;
  });
}

/**
 * Delete all tasks for a given agent. Physical removal.
 * Acquires the lock internally.
 * Returns the number of tasks removed.
 */
export function deleteAllTasks(agentId: string): number {
  return withLock(() => {
    const data = readCronFile();
    const before = data.tasks.length;
    data.tasks = data.tasks.filter((t) => t.agent_id !== agentId);
    const removed = before - data.tasks.length;
    if (removed > 0) writeCronFile(data);
    return removed;
  });
}

// ── Scheduler lease ─────────────────────────────────────────────────

/**
 * Claim the scheduler lease. Returns the token on success.
 * Throws if another live process holds the lease.
 */
export function claimSchedulerLease(): string {
  return withLock(() => {
    const data = readCronFile();
    const token = randomBytes(4).toString("hex");

    if (data.scheduler_owner) {
      const { pid, token: existingToken } = data.scheduler_owner;
      if (isProcessAlive(pid)) {
        throw new Error(
          `Scheduler lease held by PID ${pid} (token ${existingToken}). Cannot claim.`,
        );
      }
      // Stale lease from dead process — take over
    }

    data.scheduler_owner = {
      pid: process.pid,
      token,
      started_at: new Date().toISOString(),
    };
    writeCronFile(data);
    return token;
  });
}

/**
 * Verify we still hold the scheduler lease.
 */
export function verifySchedulerLease(token: string): boolean {
  const data = readCronFile();
  return (
    data.scheduler_owner !== null &&
    data.scheduler_owner.pid === process.pid &&
    data.scheduler_owner.token === token
  );
}

/**
 * Release the scheduler lease.
 */
export function releaseSchedulerLease(token: string): void {
  withLock(() => {
    const data = readCronFile();
    if (
      data.scheduler_owner &&
      data.scheduler_owner.pid === process.pid &&
      data.scheduler_owner.token === token
    ) {
      data.scheduler_owner = null;
      writeCronFile(data);
    }
  });
}

// ── Task state updates (used by scheduler) ──────────────────────────

/**
 * Update task state atomically. Acquires the lock.
 * Callback receives the task and can mutate it in-place.
 * Returns the updated task, or null if not found.
 */
export function updateTask(
  taskId: string,
  updater: (task: CronTask) => void,
): CronTask | null {
  return withLock(() => {
    const data = readCronFile();
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) return null;
    updater(task);
    writeCronFile(data);
    return { ...task };
  });
}

// ── Garbage collection ──────────────────────────────────────────────

/**
 * Remove terminal tasks (fired, missed, cancelled) older than 24 hours.
 * Acquires the lock. Returns the number of tasks removed.
 */
export function garbageCollect(): number {
  return withLock(() => {
    const data = readCronFile();
    const cutoff = Date.now() - GC_AGE_MS;
    const before = data.tasks.length;

    data.tasks = data.tasks.filter((t) => {
      if (t.status === "active") return true; // Keep active tasks
      // Terminal task — check age
      const createdAt = new Date(t.created_at).getTime();
      // Use the most recent timestamp for GC age
      const terminalAt = Math.max(
        t.last_fired_at ? new Date(t.last_fired_at).getTime() : 0,
        t.fired_at ? new Date(t.fired_at).getTime() : 0,
        t.missed_at ? new Date(t.missed_at).getTime() : 0,
        createdAt,
      );
      return terminalAt > cutoff;
    });

    const removed = before - data.tasks.length;
    if (removed > 0) writeCronFile(data);
    return removed;
  });
}

// ── Get active tasks (for scheduler) ────────────────────────────────

/**
 * Read the cron file and return only active tasks.
 * Does NOT acquire the lock (read-only operation).
 */
export function getActiveTasks(): CronTask[] {
  const data = readCronFile();
  return data.tasks.filter((t) => t.status === "active");
}

/**
 * Get the mtime of crons.json for change detection.
 * Returns 0 if the file doesn't exist.
 */
export function getCronFileMtime(): number {
  const path = getCronFilePath();
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}
