import { getOrCreateProcessTransport } from "./connection";
import {
  enqueueInboundUserMessage,
  getInboundClientMessageId,
} from "./inbound-queue";
import {
  scheduleQueuePump,
  shouldProcessInboundMessageDirectly,
  shouldQueueInboundMessage,
} from "./queue";
import { emitListenerStatus, getActiveRuntime } from "./runtime";
import { isRuntimeTeleportPending } from "./teleport";
import type { ListenerTransport } from "./transport";
import type { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

const MAX_ACCEPTED_INPUT_DISPOSITIONS = 4096;

export function getAcceptedInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
): "started" | "queued" | undefined {
  if (!clientMessageId) return undefined;
  const disposition = runtime.acceptedInputDispositions.get(clientMessageId);
  if (!disposition) return undefined;
  runtime.acceptedInputDispositions.delete(clientMessageId);
  runtime.acceptedInputDispositions.set(clientMessageId, disposition);
  return disposition;
}

export function rememberAcceptedInputDisposition(
  runtime: ConversationRuntime,
  clientMessageId: string | undefined,
  disposition: "started" | "queued",
): void {
  if (!clientMessageId) return;
  runtime.acceptedInputDispositions.delete(clientMessageId);
  runtime.acceptedInputDispositions.set(clientMessageId, disposition);
  if (
    runtime.acceptedInputDispositions.size > MAX_ACCEPTED_INPUT_DISPOSITIONS
  ) {
    const oldest = runtime.acceptedInputDispositions.keys().next().value;
    if (oldest) runtime.acceptedInputDispositions.delete(oldest);
  }
}

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
  onInputAccepted?: (result: {
    accepted: boolean;
    disposition?: "started" | "queued";
  }) => void;
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
    onInputAccepted,
  } = params;
  const clientMessageId = getInboundClientMessageId(incoming);
  let inputAcknowledged = false;
  const acknowledgeInput = (result: {
    accepted: boolean;
    disposition?: "started" | "queued";
  }): void => {
    if (inputAcknowledged) return;
    inputAcknowledged = true;
    onInputAccepted?.(result);
  };

  runtime.messageQueue = runtime.messageQueue
    .then(async () => {
      if (listener !== getActiveRuntime() || listener.intentionallyClosed) {
        acknowledgeInput({ accepted: false });
        return;
      }
      const acceptedDisposition = getAcceptedInputDisposition(
        runtime,
        clientMessageId,
      );
      if (acceptedDisposition) {
        acknowledgeInput({ accepted: true, disposition: acceptedDisposition });
        return;
      }
      if (
        isRuntimeTeleportPending(
          listener,
          runtime.agentId,
          runtime.conversationId,
        )
      ) {
        acknowledgeInput({ accepted: false });
        return;
      }
      if (
        shouldQueueInboundMessage(incoming) &&
        !shouldProcessInboundMessageDirectly(runtime, incoming)
      ) {
        const accepted = enqueueInboundUserMessage(
          runtime,
          incoming,
          actingUserId,
        );
        if (accepted) {
          rememberAcceptedInputDisposition(runtime, clientMessageId, "queued");
        }
        acknowledgeInput({
          accepted,
          ...(accepted ? { disposition: "queued" } : {}),
        });
        if (accepted) {
          scheduleQueuePump(runtime, socket, options, processQueuedTurn);
        }
        return;
      }

      emitListenerStatus(
        listener,
        options.onStatusChange,
        options.connectionId,
      );
      rememberAcceptedInputDisposition(runtime, clientMessageId, "started");
      acknowledgeInput({ accepted: true, disposition: "started" });
      // Queued turns store the actor on the queue item. Direct turns skip that
      // item, so carry the actor on the message consumed by turn.ts instead.
      const attributedIncoming =
        actingUserId && incoming.actingUserId !== actingUserId
          ? { ...incoming, actingUserId }
          : incoming;
      await processIncomingMessage(
        attributedIncoming,
        getOrCreateProcessTransport(listener),
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
      acknowledgeInput({ accepted: false });
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
