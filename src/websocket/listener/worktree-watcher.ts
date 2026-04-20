import { readdir, stat, watch } from "node:fs/promises";
import path from "node:path";
import {
  getConversationWorkingDirectory,
  getWorkingDirectoryScopeKey,
  setConversationWorkingDirectory,
} from "./cwd";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import { getConversationRuntime } from "./runtime";
import type { ListenerRuntime } from "./types";

const WORKTREES_DIR = ".letta/worktrees";

/**
 * Debounce delay after a filesystem event before we act on it.
 * `git worktree add` creates the directory and populates it in stages,
 * so we wait a bit before switching CWD.
 */
const DEBOUNCE_MS = 500;

export interface WorktreeWatcherState {
  /** The AbortController whose signal cancels the watch loop. */
  abort: AbortController;
  /** The directory being watched (e.g. `<cwd>/.letta/worktrees`). */
  watchedDir: string;
}

/**
 * Start watching `<cwd>/.letta/worktrees/` for new directories.
 *
 * When a new directory appears that wasn't present at watch-start time,
 * the conversation's CWD is automatically updated to point at the new
 * worktree — unless the stream-based detection already switched it.
 *
 * Returns a `WorktreeWatcherState` handle that must be passed to
 * `stopWorktreeWatcher()` on cleanup, or `null` if the directory
 * doesn't exist (no-op).
 */
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

  // Fire-and-forget the async watcher loop. Errors are logged, not thrown.
  runWatchLoop({
    worktreesDir,
    abort,
    runtime,
    agentId,
    conversationId,
  }).catch((err) => {
    // AbortError is expected when the watcher is stopped.
    if ((err as NodeJS.ErrnoException).name === "AbortError") return;
    console.error("[WorktreeWatcher] watch loop error:", err);
  });

  return state;
}

/**
 * Stop an active worktree watcher.
 */
export function stopWorktreeWatcher(state: WorktreeWatcherState): void {
  state.abort.abort();
}

/**
 * Stop all active worktree watchers for a listener.
 */
export function stopAllWorktreeWatchers(runtime: ListenerRuntime): void {
  for (const watcher of runtime.worktreeWatcherByConversation.values()) {
    stopWorktreeWatcher(watcher);
  }
  runtime.worktreeWatcherByConversation.clear();
}

/**
 * Convenience: stop any existing watcher for a scope, then start a new one.
 * Called after every CWD change.
 */
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

// ─── Internal ────────────────────────────────────────────

async function runWatchLoop(params: {
  worktreesDir: string;
  abort: AbortController;
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
}): Promise<void> {
  const { worktreesDir, abort, runtime, agentId, conversationId } = params;

  // Check if the worktrees directory exists.
  const dirExists = await directoryExists(worktreesDir);
  if (!dirExists) {
    // Watch the parent (.letta/) for worktrees/ creation, then recurse.
    const lettaDir = path.dirname(worktreesDir);
    const lettaDirExists = await directoryExists(lettaDir);
    if (!lettaDirExists) {
      // No .letta/ directory either — nothing to watch.
      return;
    }

    // Wait for `worktrees/` to appear inside `.letta/`.
    await waitForDirectoryCreation(lettaDir, "worktrees", abort.signal);

    // Now the worktrees dir exists — fall through to watch it.
  }

  // Snapshot existing entries so we only react to *new* ones.
  const existingEntries = new Set(await safeReaddir(worktreesDir));

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(worktreesDir, { signal: abort.signal });

  for await (const event of watcher) {
    // `rename` fires for both creation and deletion on most platforms.
    if (event.eventType !== "rename" || !event.filename) continue;

    // Skip entries that existed at watch start.
    if (existingEntries.has(event.filename)) continue;

    // Debounce: git worktree add creates the dir in stages.
    if (debounceTimer) clearTimeout(debounceTimer);
    const filename = event.filename;
    debounceTimer = setTimeout(() => {
      handleNewWorktree({
        worktreesDir,
        filename,
        runtime,
        agentId,
        conversationId,
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

  // Verify it's actually a directory.
  if (!(await directoryExists(newWorktreePath))) return;

  // Only react if THIS conversation is the one actively running a turn.
  // Multiple conversations in the same project share `.letta/worktrees/`, so
  // they all receive the same filesystem event when any agent creates a
  // worktree. Without this guard, every conversation would hijack its CWD
  // to the new worktree even if it wasn't the one that created it. The
  // conversation executing `git worktree add` is always `isProcessing`.
  const conversationRuntime = getConversationRuntime(
    runtime,
    agentId,
    conversationId,
  );
  if (!conversationRuntime?.isProcessing) return;

  // Check if CWD already points here (stream detection got it first).
  const currentCwd = getConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
  );
  if (currentCwd === newWorktreePath) return;

  console.log(
    `[WorktreeWatcher] New worktree detected: ${newWorktreePath} — switching CWD`,
  );

  // Update CWD through the standard path.
  setConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
    newWorktreePath,
  );

  // Invalidate session context so the agent gets updated CWD info.
  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  const reminderState = runtime.reminderStateByConversation.get(scopeKey);
  if (reminderState) {
    reminderState.hasSentSessionContext = false;
    reminderState.pendingSessionContextReason = "cwd_changed";
  }

  // Emit device status update so the web UI reflects the new CWD.
  if (runtime.socket) {
    emitDeviceStatusUpdate(runtime.socket, runtime, {
      agent_id: agentId,
      conversation_id: conversationId,
    });
  }
}

/**
 * Wait for a specific subdirectory to appear inside `parentDir`.
 * Resolves once the directory is created, or rejects on abort.
 */
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
