import { getOrCreateProcessTransport } from "./connection";
import { scheduleQueuePump } from "./queue";
import { getActiveRuntime } from "./runtime";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

export function createRestoredQueuePumpWake(
  runtime: ListenerRuntime,
  options: StartListenerOptions,
  processQueuedTurn: ProcessQueuedTurn,
): () => void {
  return () => {
    if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) return;
    const processTransport = getOrCreateProcessTransport(runtime);
    for (const conversationRuntime of runtime.conversationRuntimes.values()) {
      if (conversationRuntime.queueRuntime?.isEmpty === false) {
        scheduleQueuePump(
          conversationRuntime,
          processTransport,
          options,
          processQueuedTurn,
        );
      }
    }
  };
}
