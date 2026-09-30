/**
 * Parent-death detection for the Letta Code CLI process.
 *
 * When Desktop (or a terminal) spawns the CLI with `detached: true` and then
 * exits without cleanly sending SIGTERM — a crash, force-quit, or terminal
 * close where bun ignores SIGHUP — the CLI is reparented to PID 1 (launchd /
 * init) and keeps running indefinitely. Over days this accumulates enormous
 * memory through swap and compression, eventually triggering "out of
 * application memory" alerts.
 *
 * This watcher polls `process.ppid` once per second. If the parent becomes
 * PID 1 (and wasn't already at startup), the process exits gracefully.
 */

let watcher: ReturnType<typeof setInterval> | null = null;

/**
 * Start watching for parent-process death. If the parent was already PID 1
 * at startup (e.g. launched by a daemon), no watcher is installed — the
 * process is expected to manage its own lifecycle.
 */
export function startOrphanDetection(): void {
  const initialParent = process.ppid;

  // If we were already orphaned at startup, there's nothing to detect.
  if (initialParent === 1) return;

  watcher = setInterval(() => {
    if (process.ppid === 1) {
      stopOrphanDetection();
      process.exit(0);
    }
  }, 1_000);

  // Don't keep the event loop alive solely for this timer.
  watcher.unref();
}

/** Stop the orphan-detection watcher. */
export function stopOrphanDetection(): void {
  if (watcher !== null) {
    clearInterval(watcher);
    watcher = null;
  }
}
