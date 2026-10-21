import { scheduleDurableQueueRestore } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { requeueStartedInputDispositions } from "./input-disposition";
import { scheduleQueuePump } from "./queue";
import type { ListenerTransport } from "./transport";
import type {
  ConversationRuntime,
  IncomingMessage,
  StartListenerOptions,
} from "./types";

export function rehydrateClaimLostQueuedTurn(
  runtime: ConversationRuntime,
  socket: ListenerTransport,
  queuedTurn: IncomingMessage,
  opts:
    | {
        onStatusChange?: StartListenerOptions["onStatusChange"];
        connectionId?: string;
      }
    | undefined,
  processTurn: (
    message: IncomingMessage,
    socket: ListenerTransport,
    runtime: ConversationRuntime,
    onStatusChange?: StartListenerOptions["onStatusChange"],
    connectionId?: string,
    batchId?: string,
  ) => Promise<void>,
): void {
  if (
    !requeueStartedInputDispositions(
      runtime,
      queuedTurn.durableInputIdentities ?? [],
    )
  ) {
    scheduleDurableQueueRestore(runtime.listener, false);
    throw new Error("Failed to requeue claim-lost durable continuation");
  }
  if (
    !enqueueInboundUserMessage(runtime, queuedTurn, queuedTurn.actingUserId)
  ) {
    scheduleDurableQueueRestore(runtime.listener, false);
    throw new Error("Failed to rehydrate claim-lost queued continuation");
  }
  scheduleQueuePump(
    runtime,
    socket,
    (opts ?? {}) as StartListenerOptions,
    (queued, batch) =>
      processTurn(
        queued,
        socket,
        runtime,
        opts?.onStatusChange,
        queued.connectionId ?? opts?.connectionId,
        batch.batchId,
      ),
  );
}
