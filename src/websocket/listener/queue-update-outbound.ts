import type { QueueRemovalTransition } from "@/types/queue-update-protocol";
import { emitQueueUpdateIfOpen } from "./protocol-outbound";
import type { ListenerRuntime } from "./types";

type PendingQueueEmit = {
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  };
  removed: QueueRemovalTransition[];
};

const pendingQueueEmitsByRuntime = new WeakMap<
  ListenerRuntime,
  Map<string, PendingQueueEmit>
>();

function queueEmitScopeKey(scope: PendingQueueEmit["scope"]): string {
  return JSON.stringify([
    scope?.agent_id ?? null,
    scope?.conversation_id ?? null,
  ]);
}

function appendQueueRemovals(
  target: QueueRemovalTransition[],
  removed: readonly QueueRemovalTransition[],
): void {
  const known = new Set(
    target.map(
      (transition) =>
        `${transition.client_message_id}:${transition.disposition}`,
    ),
  );
  for (const transition of removed) {
    const key = `${transition.client_message_id}:${transition.disposition}`;
    if (known.has(key)) continue;
    known.add(key);
    target.push(transition);
  }
}

export function scheduleQueueEmit(
  runtime: ListenerRuntime,
  scope?: {
    agent_id?: string | null;
    conversation_id?: string | null;
  },
  removed: readonly QueueRemovalTransition[] = [],
): void {
  runtime.pendingQueueEmitScope = scope;
  let pendingByScope = pendingQueueEmitsByRuntime.get(runtime);
  if (!pendingByScope) {
    pendingByScope = new Map();
    pendingQueueEmitsByRuntime.set(runtime, pendingByScope);
  }
  const key = queueEmitScopeKey(scope);
  const pending = pendingByScope.get(key) ?? { scope, removed: [] };
  appendQueueRemovals(pending.removed, removed);
  pendingByScope.set(key, pending);

  if (runtime.queueEmitScheduled) return;
  runtime.queueEmitScheduled = true;

  queueMicrotask(() => {
    runtime.queueEmitScheduled = false;
    runtime.pendingQueueEmitScope = undefined;
    const pendingEmits = pendingQueueEmitsByRuntime.get(runtime);
    pendingQueueEmitsByRuntime.delete(runtime);
    for (const pendingEmit of pendingEmits?.values() ?? []) {
      emitQueueUpdateIfOpen(runtime, pendingEmit.scope, pendingEmit.removed);
    }
  });
}
