import { readdir, stat, watch } from "node:fs/promises";
import path from "node:path";
import { debugLog, debugWarn } from "@/utils/debug";
import {
  getConversationWorkingDirectory,
  getWorkingDirectoryScopeKey,
} from "./cwd";
import { switchConversationWorkingDirectory } from "./cwd-change";
import { getConversationRuntime } from "./runtime";
import type { ListenerRuntime } from "./types";
import {
  clearExpectedWorktreePath,
  hasExpectedWorktreePath,
} from "./worktree-ownership";

const WORKTREES_DIR = ".letta/worktrees";

const DEBOUNCE_MS = 500;

export interface WorktreeWatcherState {
  abort: AbortController;
  watchedDir: string;
}

export function startWorktreeWatcher(params: {
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
}): WorktreeWatcherState | null {
  const { runtime, agentId, conversationId } = params;
  const cwd = getConversationWorkingDirectory(runtime, agentId, conversationId);
  const worktreesDir = path.join(cwd, WORKTREES_DIR);

  const abort = new AbortController();
  const state: WorktreeWatcherState = { abort, watchedDir: worktreesDir };

  runWatchLoop({
    worktreesDir,
    abort,
    runtime,
    agentId,
    conversationId,
  }).catch((err) => {
    if ((err as NodeJS.ErrnoException).name === "AbortError") return;
    debugWarn("WorktreeWatcher", "watch loop error:", err);
  });

  return state;
}

export function stopWorktreeWatcher(state: WorktreeWatcherState): void {
  state.abort.abort();
}

export function stopAllWorktreeWatchers(runtime: ListenerRuntime): void {
  for (const watcher of runtime.worktreeWatcherByConversation.values()) {
    stopWorktreeWatcher(watcher);
  }
  runtime.worktreeWatcherByConversation.clear();
}

export function restartWorktreeWatcher(params: {
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
}): void {
  const { runtime, agentId, conversationId } = params;
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);

  const existing = runtime.worktreeWatcherByConversation.get(scopeKey);
  if (existing) {
    stopWorktreeWatcher(existing);
    runtime.worktreeWatcherByConversation.delete(scopeKey);
  }

  const state = startWorktreeWatcher(params);
  if (state) {
    runtime.worktreeWatcherByConversation.set(scopeKey, state);
  }
}

async function runWatchLoop(params: {
  worktreesDir: string;
  abort: AbortController;
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
}): Promise<void> {
  const { worktreesDir, abort, runtime, agentId, conversationId } = params;

  const dirExists = await directoryExists(worktreesDir);
  if (!dirExists) {
    const lettaDir = path.dirname(worktreesDir);
    const lettaDirExists = await directoryExists(lettaDir);
    if (!lettaDirExists) {
      return;
    }

    await waitForDirectoryCreation(lettaDir, "worktrees", abort.signal);
  }

  const existingEntries = new Set(await safeReaddir(worktreesDir));

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(worktreesDir, { signal: abort.signal });

  for await (const event of watcher) {
    if (event.eventType !== "rename" || !event.filename) continue;

    if (existingEntries.has(event.filename)) continue;

    if (debounceTimer) clearTimeout(debounceTimer);
    const filename = event.filename;
    debounceTimer = setTimeout(() => {
      void handleNewWorktree({
        worktreesDir,
        filename,
        runtime,
        agentId,
        conversationId,
      }).catch((err) => {
        debugWarn("WorktreeWatcher", "failed to handle new worktree:", err);
      });
    }, DEBOUNCE_MS);
  }
}

async function handleNewWorktree(params: {
  worktreesDir: string;
  filename: string;
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
}): Promise<void> {
  const { worktreesDir, filename, runtime, agentId, conversationId } = params;
  const newWorktreePath = path.join(worktreesDir, filename);

  if (!(await directoryExists(newWorktreePath))) return;

  const conversationRuntime = getConversationRuntime(
    runtime,
    agentId,
    conversationId,
  );
  if (!hasExpectedWorktreePath(conversationRuntime, newWorktreePath)) {
    return;
  }

  const currentCwd = getConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
  );
  if (currentCwd === newWorktreePath) {
    clearExpectedWorktreePath(conversationRuntime);
    return;
  }

  clearExpectedWorktreePath(conversationRuntime);

  debugLog(
    "WorktreeWatcher",
    `New worktree detected: ${newWorktreePath} — switching CWD`,
  );

  await switchConversationWorkingDirectory({
    runtime,
    agentId,
    conversationId,
    workingDirectory: newWorktreePath,
  });
}

async function waitForDirectoryCreation(
  parentDir: string,
  targetName: string,
  signal: AbortSignal,
): Promise<void> {
  const watcher = watch(parentDir, { signal });
  for await (const event of watcher) {
    if (
      event.eventType === "rename" &&
      event.filename === targetName &&
      (await directoryExists(path.join(parentDir, targetName)))
    ) {
      return;
    }
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

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
