import { stat, watch } from "node:fs/promises";
import { CRON_FILE_BASENAME, getCronDir } from "@/cron";
import { isListenerTransportOpen, type ListenerTransport } from "./transport";

/**
 * Debounce delay after a filesystem event before broadcasting. crons.json is
 * written via temp-file + rename, which produces several rapid events; a short
 * debounce coalesces them into a single `crons_updated` broadcast.
 */
const DEBOUNCE_MS = 250;

export interface CronFileWatcherState {
  /** The AbortController whose signal cancels the watch loop. */
  abort: AbortController;
}

/**
 * Watch `~/.letta/` for changes to `crons.json` and broadcast a general
 * `crons_updated` event over the listener transport whenever it changes.
 *
 * This is intentionally bound to the listener *connection*, not the cron
 * scheduler: only the lease-holding process runs the scheduler, but every
 * connected listener should notify its own UI when crons change on disk.
 * This closes the gap where the agent (or any other process) mutates crons
 * via the `letta cron` CLI — those writes never go through the WS command
 * handlers that normally emit `crons_updated`, so the UI never refetched.
 *
 * The directory (not the file) is watched because atomic writes swap the
 * file inode, which silently kills a file-level fs.watch handle.
 *
 * Emits with no `agent_id` so every open Schedules view refetches; the UI's
 * filter treats a scope-less event as "applies to me".
 *
 * Returns a handle to pass to `stopCronFileWatcher()` on cleanup.
 */
export function startCronFileWatcher(params: {
  transport: ListenerTransport;
}): CronFileWatcherState {
  const { transport } = params;
  const abort = new AbortController();
  const state: CronFileWatcherState = { abort };

  runWatchLoop({ transport, abort }).catch((err) => {
    // AbortError is expected when the watcher is stopped.
    if ((err as NodeJS.ErrnoException).name === "AbortError") return;
    console.error("[CronFileWatcher] watch loop error:", err);
  });

  return state;
}

/**
 * Stop an active cron-file watcher.
 */
export function stopCronFileWatcher(state: CronFileWatcherState): void {
  state.abort.abort();
}

// ─── Internal ────────────────────────────────────────────

async function runWatchLoop(params: {
  transport: ListenerTransport;
  abort: AbortController;
}): Promise<void> {
  const { transport, abort } = params;
  const cronDir = getCronDir();

  // The ~/.letta directory should already exist in any real session, but
  // guard so the watcher no-ops cleanly rather than throwing on a fresh box.
  if (!(await directoryExists(cronDir))) {
    return;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Ensure a pending debounced broadcast never fires after the watcher is
  // stopped (e.g. the listener disconnected during the debounce window).
  abort.signal.addEventListener("abort", () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  });

  const watcher = watch(cronDir, { signal: abort.signal });

  for await (const event of watcher) {
    if (abort.signal.aborted) break;

    // Only react to crons.json. On rename the filename may be the temp file
    // (`crons.json.tmp`) or the final name depending on platform/timing, so
    // match either the final file or its temp sibling.
    if (
      event.filename !== CRON_FILE_BASENAME &&
      event.filename !== `${CRON_FILE_BASENAME}.tmp`
    ) {
      continue;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      if (abort.signal.aborted) return;
      emitCronsUpdated(transport);
    }, DEBOUNCE_MS);
  }
}

function emitCronsUpdated(transport: ListenerTransport): void {
  if (!isListenerTransportOpen(transport)) return;

  // No agent_id: the UI treats a scope-less crons_updated as "refetch".
  const payload = { type: "crons_updated", timestamp: Date.now() };
  try {
    transport.send(JSON.stringify(payload));
  } catch (err) {
    console.error(
      "[CronFileWatcher] failed to send crons_updated:",
      err instanceof Error ? err.message : err,
    );
  }
}

async function directoryExists(dir: string): Promise<boolean> {
  try {
    const stats = await stat(dir);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
