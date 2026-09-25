/**
 * Task-reference resolution for `letta cron get`/`delete` (LET-10492).
 *
 * `add` requires `--name`, so names are the handle users (and agents)
 * actually remember — but the stores address tasks by ID. This module
 * resolves a positional that didn't match any ID as a task *name* in the
 * store owned by the current execution environment.
 */

import { listCloudSchedules } from "@/backend/api/schedules";
import { listTasks } from "@/cron";
import { isManagedCloudSandbox } from "@/cron/runner";

export interface ResolvedTaskRef {
  /** The task/schedule id the reference resolved to. */
  id: string;
  /** Where the match was found (informs which store to act on first). */
  store: "local" | "cloud";
}

/**
 * The local runner path never needs settings, so the cron subcommand does not
 * initialize them upfront; every cloud API call does (server URL + auth).
 * Idempotent — safe to call before each cloud request.
 */
export async function ensureSettingsForCloud(): Promise<void> {
  const { settingsManager } = await import("@/settings-manager");
  await settingsManager.initialize();
}

/**
 * Resolve a `get`/`delete` positional that didn't match any task ID as a
 * task name. `letta cron delete <name>` failing with "not found" while the
 * schedule keeps firing is a footgun.
 *
 * Searches the store owned by the current execution environment. Exact-match
 * only. Returns:
 * - `{ id, store }` for exactly one match
 * - `{ ambiguous }` with the matching ids when several tasks share the name
 * - `null` for no match (callers keep their existing not-found error)
 */
export async function resolveTaskName(
  name: string,
  options: {
    agentId: string;
  },
): Promise<ResolvedTaskRef | { ambiguous: ResolvedTaskRef[] } | null> {
  const matches: ResolvedTaskRef[] = [];

  if (!isManagedCloudSandbox()) {
    for (const task of listTasks()) {
      if (task.name === name) {
        matches.push({ id: task.id, store: "local" });
      }
    }
  } else if (options.agentId) {
    try {
      await ensureSettingsForCloud();
      const response = await listCloudSchedules(options.agentId);
      for (const schedule of response.scheduled_messages) {
        if (schedule.name === name) {
          matches.push({ id: schedule.id, store: "cloud" });
        }
      }
    } catch {
      // Name lookup is best-effort sugar on top of ID addressing: a failed
      // Cloud list falls through to the caller's ID-based not-found path.
    }
  }

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0] ?? null;
  return { ambiguous: matches };
}

export function printAmbiguousTaskName(
  name: string,
  matches: ResolvedTaskRef[],
): void {
  console.error(
    `Error: multiple tasks are named "${name}". Use an ID instead:`,
  );
  for (const match of matches) {
    console.error(`  ${match.id} (${match.store})`);
  }
}
