import { describe, expect, test } from "bun:test";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { getWorkingDirectoryScopeKey } from "@/websocket/listener/cwd";
import {
  __watcherIdleStopTestUtils,
  createConversationRuntime,
  evictConversationRuntimeIfIdle,
} from "@/websocket/listener/runtime";
import type { ListenerRuntime } from "@/websocket/listener/types";

const AGENT_ID = "agent-runtime-eviction";
const CONVERSATION_ID = "conv-runtime-eviction";

function seedWatcher(listener: ListenerRuntime): {
  scopeKey: string;
  wasAborted: () => boolean;
} {
  const scopeKey = getWorkingDirectoryScopeKey(AGENT_ID, CONVERSATION_ID);
  const abort = new AbortController();
  listener.worktreeWatcherByConversation.set(scopeKey, {
    abort,
    watchedDir: "/tmp/worktrees",
  });
  return { scopeKey, wasAborted: () => abort.signal.aborted };
}

describe("conversation runtime eviction and worktree watcher idle stop", () => {
  test("eviction schedules an idle stop instead of killing the watcher", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const { scopeKey, wasAborted } = seedWatcher(listener);
    const runtime = createConversationRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );

    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);

    // Watchers track worktree changes between turns for attached clients, so
    // routine post-turn eviction must not stop them immediately.
    expect(wasAborted()).toBe(false);
    expect(listener.worktreeWatcherByConversation.has(scopeKey)).toBe(true);
    expect(__watcherIdleStopTestUtils.hasPending(listener, scopeKey)).toBe(
      true,
    );

    __watcherIdleStopTestUtils.firePending(listener);
    expect(wasAborted()).toBe(true);
    expect(listener.worktreeWatcherByConversation.has(scopeKey)).toBe(false);
  });

  test("recreating the runtime cancels the pending watcher stop", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const { scopeKey, wasAborted } = seedWatcher(listener);
    const runtime = createConversationRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );

    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);
    expect(__watcherIdleStopTestUtils.hasPending(listener, scopeKey)).toBe(
      true,
    );

    // Conversation becomes active again before the TTL elapses.
    createConversationRuntime(listener, AGENT_ID, CONVERSATION_ID);
    expect(__watcherIdleStopTestUtils.hasPending(listener, scopeKey)).toBe(
      false,
    );

    __watcherIdleStopTestUtils.firePending(listener);
    expect(wasAborted()).toBe(false);
    expect(listener.worktreeWatcherByConversation.has(scopeKey)).toBe(true);
  });

  test("a stale idle stop does not kill a replacement watcher", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const { scopeKey } = seedWatcher(listener);
    const runtime = createConversationRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    expect(evictConversationRuntimeIfIdle(runtime)).toBe(true);

    // A CWD change replaces the watcher after eviction was scheduled.
    const replacementAbort = new AbortController();
    listener.worktreeWatcherByConversation.set(scopeKey, {
      abort: replacementAbort,
      watchedDir: "/tmp/worktrees-2",
    });

    __watcherIdleStopTestUtils.firePending(listener);
    expect(replacementAbort.signal.aborted).toBe(false);
    expect(listener.worktreeWatcherByConversation.has(scopeKey)).toBe(true);
  });

  test("eviction refuses while the conversation has pending work", () => {
    const listener = __listenClientTestUtils.createListenerRuntime();
    const runtime = createConversationRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    runtime.pendingTurns = 1;

    expect(evictConversationRuntimeIfIdle(runtime)).toBe(false);
    expect(listener.conversationRuntimes.has(runtime.key)).toBe(true);
  });
});
