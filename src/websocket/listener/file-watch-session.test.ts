import { describe, expect, test } from "bun:test";
import {
  createFileWatchSession,
  type FileCommandWatcher,
  type FileWatchDependencies,
} from "./file-watch-session";

class FakeWatcher implements FileCommandWatcher {
  closeCount = 0;
  errorListener: (() => void) | undefined;

  close(): void {
    this.closeCount += 1;
  }

  on(_event: "error", listener: () => void): this {
    this.errorListener = listener;
    return this;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (!resolvePromise) throw new Error("Deferred promise is not ready");
      resolvePromise(value);
    },
  };
}

function createDependencies(options?: {
  beforeWatch?: () => void;
  stat?: FileWatchDependencies["stat"];
}): {
  dependencies: FileWatchDependencies;
  watchers: FakeWatcher[];
  emitWatchEvent: (eventType: "change" | "rename") => void;
} {
  const watchers: FakeWatcher[] = [];
  let watchListener: ((eventType: "change" | "rename") => void) | undefined;
  return {
    watchers,
    dependencies: {
      watch: (_path, _watchOptions, listener) => {
        options?.beforeWatch?.();
        watchListener = listener;
        const watcher = new FakeWatcher();
        watchers.push(watcher);
        return watcher;
      },
      stat: options?.stat ?? (async () => ({ mtimeMs: 1234.4 })),
    },
    emitWatchEvent(eventType) {
      if (!watchListener) throw new Error("No watcher has been created");
      watchListener(eventType);
    },
  };
}

function createTaskCollector(): {
  runDetachedTask: (task: () => Promise<void>) => void;
  flush: () => Promise<void>;
} {
  const tasks: Promise<void>[] = [];
  return {
    runDetachedTask(task) {
      tasks.push(task());
    },
    async flush() {
      await Promise.all(tasks);
    },
  };
}

describe("file watch session lifecycle", () => {
  test("disposal while setup is suspended prevents watcher creation", async () => {
    const dependencyLoad = deferred<FileWatchDependencies>();
    const fake = createDependencies();
    const tasks = createTaskCollector();
    const session = createFileWatchSession({
      emitFileChanged: () => {},
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: () => dependencyLoad.promise,
    });

    session.watchFile("/tmp/suspended.txt");
    session.dispose();
    dependencyLoad.resolve(fake.dependencies);
    await tasks.flush();

    expect(fake.watchers).toHaveLength(0);
  });

  test("closes a watcher created at the disposal boundary exactly once", async () => {
    const tasks = createTaskCollector();
    let session: ReturnType<typeof createFileWatchSession>;
    const fake = createDependencies({ beforeWatch: () => session.dispose() });
    session = createFileWatchSession({
      emitFileChanged: () => {},
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: async () => fake.dependencies,
    });

    session.watchFile("/tmp/boundary.txt");
    await tasks.flush();
    session.dispose();

    expect(fake.watchers).toHaveLength(1);
    expect(fake.watchers[0]?.closeCount).toBe(1);
  });

  test("does not emit a file change when disposal races with stat", async () => {
    const statResult = deferred<{ mtimeMs: number }>();
    let statStarted = false;
    const fake = createDependencies({
      stat: async () => {
        statStarted = true;
        return statResult.promise;
      },
    });
    const tasks = createTaskCollector();
    const emitted: Array<{ path: string; lastModified: number }> = [];
    const session = createFileWatchSession({
      emitFileChanged: (path, lastModified) =>
        emitted.push({ path, lastModified }),
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: async () => fake.dependencies,
      debounceMs: 0,
    });

    session.watchFile("/tmp/changed.txt");
    await tasks.flush();
    fake.emitWatchEvent("change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(statStarted).toBe(true);

    session.dispose();
    statResult.resolve({ mtimeMs: 4567.8 });
    await Promise.resolve();

    expect(emitted).toEqual([]);
    expect(fake.watchers[0]?.closeCount).toBe(1);
  });

  test("emits a rounded modification time for an active watcher", async () => {
    const fake = createDependencies();
    const tasks = createTaskCollector();
    const emitted: Array<{ path: string; lastModified: number }> = [];
    const session = createFileWatchSession({
      emitFileChanged: (path, lastModified) =>
        emitted.push({ path, lastModified }),
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: async () => fake.dependencies,
      debounceMs: 0,
    });

    session.watchFile("/tmp/active-change.txt");
    await tasks.flush();
    fake.emitWatchEvent("rename");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();

    expect(emitted).toEqual([
      { path: "/tmp/active-change.txt", lastModified: 1234 },
    ]);
    session.dispose();
  });

  test("unwatch during suspended setup cancels watcher creation", async () => {
    const dependencyLoad = deferred<FileWatchDependencies>();
    const fake = createDependencies();
    const tasks = createTaskCollector();
    const session = createFileWatchSession({
      emitFileChanged: () => {},
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: () => dependencyLoad.promise,
    });

    session.watchFile("/tmp/cancelled.txt");
    session.unwatchFile("/tmp/cancelled.txt");
    dependencyLoad.resolve(fake.dependencies);
    await tasks.flush();

    expect(fake.watchers).toHaveLength(0);
  });

  test("ref-counts duplicate requests that arrive during setup", async () => {
    const dependencyLoad = deferred<FileWatchDependencies>();
    const fake = createDependencies();
    const tasks = createTaskCollector();
    const session = createFileWatchSession({
      emitFileChanged: () => {},
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: () => dependencyLoad.promise,
    });

    session.watchFile("/tmp/shared.txt");
    session.watchFile("/tmp/shared.txt");
    session.unwatchFile("/tmp/shared.txt");
    dependencyLoad.resolve(fake.dependencies);
    await tasks.flush();

    expect(fake.watchers).toHaveLength(1);
    expect(fake.watchers[0]?.closeCount).toBe(0);
    session.unwatchFile("/tmp/shared.txt");
    expect(fake.watchers[0]?.closeCount).toBe(1);
  });

  test("closes active watchers idempotently on repeated disposal", async () => {
    const fake = createDependencies();
    const tasks = createTaskCollector();
    const session = createFileWatchSession({
      emitFileChanged: () => {},
      runDetachedTask: tasks.runDetachedTask,
      loadDependencies: async () => fake.dependencies,
    });

    session.watchFile("/tmp/active.txt");
    await tasks.flush();
    session.dispose();
    session.dispose();
    fake.watchers[0]?.errorListener?.();

    expect(fake.watchers[0]?.closeCount).toBe(1);
  });
});
