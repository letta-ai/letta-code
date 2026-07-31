export interface FileCommandWatcher {
  close: () => void;
  on: (event: "error", listener: () => void) => unknown;
}

export interface FileWatchDependencies {
  watch: (
    path: string,
    options: { persistent: false },
    listener: (eventType: "change" | "rename") => void,
  ) => FileCommandWatcher;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
}

export type LoadFileWatchDependencies = () => Promise<FileWatchDependencies>;

interface PendingWatch {
  cancelled: boolean;
  refCount: number;
}

interface ActiveWatch {
  watcher: FileCommandWatcher;
  refCount: number;
}

interface FileWatchSessionParams {
  emitFileChanged: (path: string, lastModified: number) => void;
  runDetachedTask: (task: () => Promise<void>) => void;
  loadDependencies?: LoadFileWatchDependencies;
  debounceMs?: number;
}

async function loadNodeFileWatchDependencies(): Promise<FileWatchDependencies> {
  const [{ watch }, { stat }] = await Promise.all([
    import("node:fs"),
    import("node:fs/promises"),
  ]);
  return { watch, stat };
}

export function createFileWatchSession(params: FileWatchSessionParams): {
  watchFile: (path: string) => void;
  unwatchFile: (path: string) => void;
  dispose: () => void;
} {
  const activeWatches = new Map<string, ActiveWatch>();
  const pendingWatches = new Map<string, PendingWatch>();
  const debounceTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; watcher: FileCommandWatcher }
  >();
  const closedWatchers = new WeakSet<FileCommandWatcher>();
  const loadDependencies =
    params.loadDependencies ?? loadNodeFileWatchDependencies;
  const debounceMs = params.debounceMs ?? 150;
  let disposed = false;

  function closeWatcher(watcher: FileCommandWatcher): void {
    if (closedWatchers.has(watcher)) return;
    closedWatchers.add(watcher);
    watcher.close();
  }

  function clearDebounce(path: string, watcher?: FileCommandWatcher): void {
    const entry = debounceTimers.get(path);
    if (!entry || (watcher && entry.watcher !== watcher)) return;
    clearTimeout(entry.timer);
    debounceTimers.delete(path);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    for (const { watcher } of activeWatches.values()) closeWatcher(watcher);
    activeWatches.clear();
    for (const pending of pendingWatches.values()) pending.cancelled = true;
    pendingWatches.clear();
    for (const { timer } of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
  }

  function watchFile(path: string): void {
    if (disposed) return;

    const active = activeWatches.get(path);
    if (active) {
      active.refCount += 1;
      return;
    }

    const pending = pendingWatches.get(path);
    if (pending && !pending.cancelled) {
      pending.refCount += 1;
      return;
    }

    const setup: PendingWatch = { cancelled: false, refCount: 1 };
    pendingWatches.set(path, setup);
    params.runDetachedTask(async () => {
      let watcher: FileCommandWatcher | undefined;
      try {
        const dependencies = await loadDependencies();
        if (disposed || setup.cancelled) return;

        watcher = dependencies.watch(
          path,
          { persistent: false },
          (eventType) => {
            const current = activeWatches.get(path);
            if (
              disposed ||
              !watcher ||
              current?.watcher !== watcher ||
              (eventType !== "change" && eventType !== "rename")
            ) {
              return;
            }
            clearDebounce(path, watcher);
            const timer = setTimeout(() => {
              if (debounceTimers.get(path)?.timer !== timer) return;
              debounceTimers.delete(path);
              if (disposed) return;
              void dependencies
                .stat(path)
                .then((fileStat) => {
                  const current = activeWatches.get(path);
                  if (disposed || current?.watcher !== watcher) return;
                  params.emitFileChanged(path, Math.round(fileStat.mtimeMs));
                })
                .catch(() => {
                  const current = activeWatches.get(path);
                  if (current?.watcher !== watcher || !watcher) return;
                  closeWatcher(watcher);
                  activeWatches.delete(path);
                });
            }, debounceMs);
            debounceTimers.set(path, {
              watcher,
              timer,
            });
          },
        );

        if (disposed || setup.cancelled) {
          closeWatcher(watcher);
          return;
        }

        watcher.on("error", () => {
          if (!watcher) return;
          closeWatcher(watcher);
          const current = activeWatches.get(path);
          if (current?.watcher === watcher) activeWatches.delete(path);
          clearDebounce(path, watcher);
        });

        if (disposed || setup.cancelled) {
          closeWatcher(watcher);
          return;
        }
        activeWatches.set(path, { watcher, refCount: setup.refCount });
      } catch {
        if (watcher) closeWatcher(watcher);
      } finally {
        if (pendingWatches.get(path) === setup) pendingWatches.delete(path);
      }
    });
  }

  function unwatchFile(path: string): void {
    if (disposed) return;

    const active = activeWatches.get(path);
    if (active) {
      active.refCount -= 1;
      if (active.refCount <= 0) {
        closeWatcher(active.watcher);
        activeWatches.delete(path);
      }
    } else {
      const pending = pendingWatches.get(path);
      if (pending && !pending.cancelled) {
        pending.refCount -= 1;
        if (pending.refCount <= 0) pending.cancelled = true;
      }
    }
    clearDebounce(path, active?.watcher);
  }

  return { watchFile, unwatchFile, dispose };
}
