let watcher: ReturnType<typeof setInterval> | null = null;

export function startOrphanDetection(): void {
  const initialParent = process.ppid;

  if (initialParent === 1) return;

  watcher = setInterval(() => {
    if (process.ppid === 1) {
      stopOrphanDetection();
      process.exit(0);
    }
  }, 1_000);

  watcher.unref();
}

export function stopOrphanDetection(): void {
  if (watcher !== null) {
    clearInterval(watcher);
    watcher = null;
  }
}
