import {
  existsSync,
  type FSWatcher,
  readdirSync,
  realpathSync,
  statSync,
  watch,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

type WatchListener = (
  eventType: string,
  filename: string | Buffer | null,
) => void;

export type SkillWatchFunction = (
  path: string,
  options: { persistent: false; recursive: boolean },
  listener: WatchListener,
) => FSWatcher;

function defaultWatchFunction(
  path: string,
  options: { persistent: false; recursive: boolean },
  listener: WatchListener,
): FSWatcher {
  return watch(path, options, listener);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function findNearestExistingDirectory(path: string): string | null {
  let candidate = resolve(path);
  while (!isDirectory(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    candidate = parent;
  }
  return candidate;
}

function collectSymlinkDirectoryTargets(
  path: string,
  targets: Set<string>,
  visited: Set<string>,
): void {
  let realPath: string;
  try {
    realPath = realpathSync(path);
  } catch {
    return;
  }
  if (visited.has(realPath)) {
    return;
  }
  visited.add(realPath);

  try {
    const entries = readdirSync(path, {
      encoding: "utf8",
      withFileTypes: true,
    });
    for (const entry of entries) {
      const entryPath = resolve(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (!isDirectory(entryPath)) {
          continue;
        }
        try {
          targets.add(realpathSync(entryPath));
        } catch {
          continue;
        }
        collectSymlinkDirectoryTargets(entryPath, targets, visited);
        continue;
      }
      if (entry.isDirectory()) {
        collectSymlinkDirectoryTargets(entryPath, targets, visited);
      }
    }
  } catch {
    return;
  }
}

/**
 * Keeps skill cache validation off the model-request path. Each configured
 * root is watched until its first mutation, which invalidates the cache and
 * closes all watchers. The next request installs fresh watchers while it
 * rebuilds the skill snapshot.
 */
export class ClientSkillsWatcher {
  private readonly watchersByRoot = new Map<string, FSWatcher[]>();

  constructor(
    private readonly onChange: () => void,
    private readonly watchFunction: SkillWatchFunction = defaultWatchFunction,
  ) {}

  ensureRoots(roots: string[]): void {
    for (const root of roots) {
      const normalizedRoot = resolve(root.trim());
      if (!root.trim() || this.watchersByRoot.has(normalizedRoot)) {
        continue;
      }
      this.watchRoot(normalizedRoot);
    }
  }

  close(): void {
    for (const watchers of this.watchersByRoot.values()) {
      for (const watcher of watchers) {
        watcher.close();
      }
    }
    this.watchersByRoot.clear();
  }

  private watchRoot(root: string): void {
    const existingDirectory = findNearestExistingDirectory(root);
    if (!existingDirectory) {
      return;
    }

    const watchPaths = new Set<string>();
    let recursive = false;
    let awaitedChild: string | null = null;
    if (existsSync(root)) {
      recursive = true;
      watchPaths.add(root);
      collectSymlinkDirectoryTargets(root, watchPaths, new Set());
    } else {
      watchPaths.add(existingDirectory);
      awaitedChild = relative(existingDirectory, root).split(sep)[0] ?? null;
    }

    const watchers: FSWatcher[] = [];
    const invalidate = (): void => {
      this.close();
      this.onChange();
    };

    try {
      for (const path of watchPaths) {
        const watcher = this.watchFunction(
          path,
          { persistent: false, recursive },
          (_eventType, filename) => {
            if (
              awaitedChild &&
              filename !== awaitedChild &&
              filename?.toString() !== awaitedChild
            ) {
              return;
            }
            invalidate();
          },
        );
        watcher.unref?.();
        watcher.on("error", invalidate);
        watchers.push(watcher);
      }
      this.watchersByRoot.set(root, watchers);
    } catch {
      for (const watcher of watchers) {
        watcher.close();
      }
      // Match Codex's fallback: a platform without filesystem watching keeps
      // the current snapshot until explicit invalidation or process restart.
    }
  }
}
