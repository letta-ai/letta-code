import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  scheduleQueuePump,
  shouldProcessInboundMessageDirectly,
  shouldQueueInboundMessage,
} from "./queue";
import { emitListenerStatus, getActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import type { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

export function dispatchInboundMessageWhenReady(params: {
  listener: ListenerRuntime;
  runtime: ConversationRuntime;
  incoming: IncomingMessage;
  socket: ListenerTransport;
  options: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
  processIncomingMessage: typeof handleIncomingMessage;
  actingUserId?: string;
  trackListenerError: (
    errorType: string,
    error: unknown,
    context: string,
  ) => void;
}): void {
  const {
    listener,
    runtime,
    incoming,
    socket,
    options,
    processQueuedTurn,
    processIncomingMessage,
    actingUserId,
    trackListenerError,
  } = params;

  runtime.messageQueue = runtime.messageQueue
    .then(async () => {
      if (listener !== getActiveRuntime() || listener.intentionallyClosed) {
        return;
      }
      if (
        shouldQueueInboundMessage(incoming) &&
        !shouldProcessInboundMessageDirectly(runtime, incoming)
      ) {
        enqueueInboundUserMessage(runtime, incoming, actingUserId);
        scheduleQueuePump(runtime, socket, options, processQueuedTurn);
        return;
      }

      emitListenerStatus(
        listener,
        options.onStatusChange,
        options.connectionId,
      );
      await processIncomingMessage(
        incoming,
        socket,
        runtime,
        options.onStatusChange,
        options.connectionId,
      );
      emitListenerStatus(
        listener,
        options.onStatusChange,
        options.connectionId,
      );
      if (
        runtime.queueRuntime.length > 0 ||
        runtime.queuePumpScheduled ||
        runtime.queuePumpActive
      ) {
        scheduleQueuePump(runtime, socket, options, processQueuedTurn);
      }
    })
    .catch((error: unknown) => {
      trackListenerError(
        "listener_queued_input_failed",
        error,
        "listener_message_queue",
      );
      if (process.env.DEBUG) {
        console.error("[Listen] Error handling queued input:", error);
      }
      emitListenerStatus(
        listener,
        options.onStatusChange,
        options.connectionId,
      );
      scheduleQueuePump(runtime, socket, options, processQueuedTurn);
    });
}
