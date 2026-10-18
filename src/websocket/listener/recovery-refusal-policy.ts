import { debugWarn } from "@/utils/debug";
import { acquireRecoveryClaim } from "./recovery-ownership";
import type { ListenerRuntime } from "./types";

const refusals = new WeakMap<
  ListenerRuntime,
  {
    identity: string;
    records: Map<string, { count: number; next: number }>;
  }
>();

/** Connection-local only: never retire durable work because another owner refused it. */
export function recoveryRefusalPolicy(
  listener: ListenerRuntime,
  record: { agentId: string; conversationId: string },
  acquire = acquireRecoveryClaim,
  now = Date.now,
) {
  const identity = JSON.stringify([
    listener.connectionId,
    listener.connectionGeneration,
  ]);
  let state = refusals.get(listener);
  if (state?.identity !== identity) {
    state = { identity, records: new Map() };
    refusals.set(listener, state);
  }
  const records = state.records;
  const key = JSON.stringify([record.agentId, record.conversationId]);
  return {
    get ready() {
      return now() >= (records.get(key)?.next ?? 0);
    },
    delay(base: number) {
      return Math.max(base, (records.get(key)?.next ?? 0) - now());
    },
    async acquire(...args: Parameters<typeof acquireRecoveryClaim>) {
      let refused = false;
      const claim = await acquire(args[0], args[1], {
        ...args[2],
        onOwnerMismatch: () => {
          refused = true;
          const count = (records.get(key)?.count ?? 0) + 1;
          records.set(key, {
            count,
            next:
              count >= 5
                ? Infinity
                : now() + Math.min(5000 * 2 ** (count - 1), 300_000),
          });
          if (count === 5)
            debugWarn(
              "recovery",
              `Recovery refused because another connection owns conversation ${record.conversationId}; abandoned until the next reconnect`,
            );
        },
      });
      if (!refused) records.delete(key);
      return claim;
    },
  };
}
