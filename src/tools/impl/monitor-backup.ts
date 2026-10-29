import { runWithRuntimeContext } from "@/runtime-context";
import { wake } from "./wake";

/**
 * Optional backup Wake for a Monitor: a durable one-shot wake that fires if the
 * monitor stays silent for `afterSeconds`, measured from its start or its last
 * event. It goes through the same scheduler as the Wake tool, so it still fires
 * if this process dies, which is exactly when an in-process timer would not.
 */

export const MIN_BACKUP_AFTER_SECONDS = 60;
export const MAX_BACKUP_AFTER_SECONDS = 604_800;
const MAX_WAKE_NAME_LENGTH = 80;
const MAX_WAKE_PROMPT_LENGTH = 4000;
// Events re-arm the backup at most this often; a burst of events becomes one
// cancel-and-create rather than one per line.
const DEFAULT_REARM_COALESCE_MS = 30_000;

type WakeFn = typeof wake;

interface BackupScope {
  agentId: string;
  conversationId: string;
  actingUserId?: string | null;
}

interface MonitorBackup {
  taskId: string;
  name: string;
  prompt: string;
  afterSeconds: number;
  scope: BackupScope;
  wakeId: string | null;
  queue: Promise<void>;
  rearmTimer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

const backups = new Map<string, MonitorBackup>();
let wakeImpl: WakeFn = wake;
let rearmCoalesceMs = DEFAULT_REARM_COALESCE_MS;

export function validateBackupAfterSeconds(value: unknown): void {
  if (value === undefined) return;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_BACKUP_AFTER_SECONDS ||
    value > MAX_BACKUP_AFTER_SECONDS
  ) {
    throw new Error(
      `Monitor backup_after_seconds must be an integer between ${MIN_BACKUP_AFTER_SECONDS} and ${MAX_BACKUP_AFTER_SECONDS}`,
    );
  }
}

function defaultPrompt(
  taskId: string,
  description: string,
  afterSeconds: number,
): string {
  const minutes = Math.round(afterSeconds / 60);
  return `Monitor "${description}" (task ${taskId}) has been silent for ${minutes} min. Check the real state of what it watches, not the monitor, then report what you find, re-arm it, or stop it.`;
}

function wakeName(description: string): string {
  const name = `Monitor backup: ${description}`;
  return name.length > MAX_WAKE_NAME_LENGTH
    ? `${name.slice(0, MAX_WAKE_NAME_LENGTH - 1)}…`
    : name;
}

function runInScope<T>(scope: BackupScope, fn: () => T): T {
  return runWithRuntimeContext(
    {
      agentId: scope.agentId,
      conversationId: scope.conversationId,
      ...(scope.actingUserId
        ? { actingUserId: scope.actingUserId }
        : scope.actingUserId === null
          ? { suppressActingUserFallback: true }
          : {}),
    },
    fn,
  );
}

function parseWakeResult(content: string): {
  id?: string;
  error?: string;
} {
  try {
    return JSON.parse(content) as { id?: string; error?: string };
  } catch {
    return { error: content };
  }
}

async function createBackupWake(backup: MonitorBackup): Promise<string> {
  const result = await runInScope(backup.scope, () =>
    wakeImpl({
      action: "create",
      name: backup.name,
      prompt: backup.prompt,
      after_seconds: backup.afterSeconds,
    }),
  );
  const parsed = parseWakeResult(result.content);
  if (result.status !== "success" || !parsed.id) {
    throw new Error(parsed.error ?? "the backup wake was not created");
  }
  return parsed.id;
}

async function cancelBackupWake(backup: MonitorBackup): Promise<void> {
  const id = backup.wakeId;
  if (!id) return;
  backup.wakeId = null;
  // A wake that already fired or was cancelled by hand is fine to miss.
  await runInScope(backup.scope, () => wakeImpl({ action: "cancel", id }));
}

function enqueue(backup: MonitorBackup, step: () => Promise<void>): void {
  backup.queue = backup.queue.then(step).catch(() => {
    // A failed re-arm leaves the previous wake (if any) armed, which only makes
    // the backup fire early. Nothing to surface mid-stream.
  });
}

/**
 * Arms the backup wake for a newly started monitor. Returns a line for the
 * Monitor tool result describing whether the backup is armed.
 */
export async function armMonitorBackup(params: {
  taskId: string;
  description: string;
  afterSeconds: number;
  prompt?: string;
  scope: BackupScope | undefined;
  /** Whether the monitor is still running once the wake has been created. */
  isRunning: () => boolean;
}): Promise<string> {
  const { taskId, description, afterSeconds, scope } = params;
  if (!scope) {
    return "Backup wake not armed: this monitor has no agent conversation to wake.";
  }
  const prompt = (
    params.prompt?.trim() || defaultPrompt(taskId, description, afterSeconds)
  ).slice(0, MAX_WAKE_PROMPT_LENGTH);
  const backup: MonitorBackup = {
    taskId,
    name: wakeName(description),
    prompt,
    afterSeconds,
    scope,
    wakeId: null,
    queue: Promise.resolve(),
    rearmTimer: undefined,
    stopped: false,
  };
  try {
    backup.wakeId = await createBackupWake(backup);
  } catch (error) {
    return `Backup wake not armed: ${error instanceof Error ? error.message : String(error)}`;
  }
  backups.set(taskId, backup);
  if (!params.isRunning()) {
    // The monitor ended while the wake was being created.
    await cancelMonitorBackup(taskId);
    return "Backup wake not armed: the monitor already ended.";
  }
  return `Backup wake ${backup.wakeId} armed: it fires if this monitor is silent for ${afterSeconds}s, and each event resets the clock.`;
}

/** Called for every event the monitor emits; resets the silence clock. */
export function noteMonitorBackupActivity(taskId: string): void {
  const backup = backups.get(taskId);
  if (!backup || backup.stopped || backup.rearmTimer) return;
  backup.rearmTimer = setTimeout(() => {
    backup.rearmTimer = undefined;
    if (backup.stopped) return;
    enqueue(backup, async () => {
      if (backup.stopped) return;
      await cancelBackupWake(backup);
      if (backup.stopped) return;
      backup.wakeId = await createBackupWake(backup);
    });
  }, rearmCoalesceMs);
  backup.rearmTimer.unref?.();
}

/** Cancels the backup when the monitor ends or is stopped on purpose. */
export function cancelMonitorBackup(taskId: string): Promise<void> {
  const backup = backups.get(taskId);
  if (!backup) return Promise.resolve();
  backups.delete(taskId);
  backup.stopped = true;
  if (backup.rearmTimer) {
    clearTimeout(backup.rearmTimer);
    backup.rearmTimer = undefined;
  }
  enqueue(backup, () => cancelBackupWake(backup));
  return backup.queue;
}

/**
 * On process exit, forget backups without cancelling them: a monitor that dies
 * with its process is exactly the case the durable backup wake is for.
 */
export function detachMonitorBackupsForProcessExit(): void {
  for (const backup of backups.values()) {
    backup.stopped = true;
    if (backup.rearmTimer) clearTimeout(backup.rearmTimer);
  }
  backups.clear();
}

export function __setMonitorBackupWakeForTests(fn: WakeFn | null): void {
  wakeImpl = fn ?? wake;
}

export function __setMonitorBackupRearmDelayMsForTests(
  ms: number | null,
): void {
  rearmCoalesceMs = ms ?? DEFAULT_REARM_COALESCE_MS;
}

export function __getMonitorBackupWakeIdForTests(
  taskId: string,
): string | null {
  return backups.get(taskId)?.wakeId ?? null;
}
