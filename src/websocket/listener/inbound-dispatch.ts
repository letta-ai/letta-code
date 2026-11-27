import { readMcpOriginatorDelivery } from "@/agent/mcp-originator-tokens";
import { readGitAttribution } from "@/types/git-attribution";
import type { InputCreateMessagePayload } from "@/types/protocol_v2";
import type { ConversationRuntimeScope } from "@/types/runtime-scope";
import { debugLog, isDebugEnabled } from "@/utils/debug";
import { getOrCreateProcessTransport } from "./connection";
import {
  enqueueInboundUserMessage,
  getInboundClientMessageId,
} from "./inbound-queue";
import {
  commitInputDisposition,
  forgetQueuedInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import {
  attachTerminalConsumerToLiveAcceptedInput,
  hasLiveAcceptedInputOwner,
} from "./input-disposition-ownership";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import { scheduleQueuePump, shouldQueueInboundMessage } from "./queue";
import {
  emitListenerStatus,
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
} from "./runtime";
import { isRuntimeTeleportPending } from "./teleport";
import type { ListenerTransport } from "./transport";
import type { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  IncomingMessage,
  ListenerConnectionId,
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

export function createIncomingMessage(
  scope: ConversationRuntimeScope,
  payload: InputCreateMessagePayload,
  connectionId?: ListenerConnectionId,
  frame?: {
    terminal_consumer_id?: string | null;
    super_run_id?: unknown;
    mcp_originator_token?: unknown;
    mcp_originator_generation?: unknown;
  },
): IncomingMessage {
  const mcpOriginator = readMcpOriginatorDelivery(frame);
  const terminalConsumerId = frame?.terminal_consumer_id ?? undefined;
  if (Object.hasOwn(payload, "external_tool_scope_ids")) {
    debugLog("Listen", "Ignoring deprecated external_tool_scope_ids");
  }
  return {
    type: "message",
    receivedAt: Date.now(),
    connectionId,
    agentId: scope.agent_id,
    conversationId: scope.conversation_id,
    clientToolAllowlist: payload.client_tool_allowlist,
    clientToolset: payload.client_toolset,
    clientPreferences: payload.client_preferences,
    excludeInteractiveTools: payload.exclude_interactive_tools,
    responseFormat: payload.response_format,
    imageFailureMode: payload.image_failure_mode,
    gitAttribution: readGitAttribution(payload.git_attribution),
    ...(terminalConsumerId
      ? { terminalConsumerIds: [terminalConsumerId] }
      : {}),
    ...(mcpOriginator.superRunId
      ? { mcpOriginatorSuperRunId: mcpOriginator.superRunId }
      : {}),
    ...(mcpOriginator.superRunId
      ? { mcpOriginatorTokenPresent: Boolean(mcpOriginator.token) }
      : {}),
    messages: payload.messages,
  };
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
    duplicate?: boolean;
    mayRecreateOwner?: () => boolean;
  }) => void;
  forgetQueuedInput?: typeof forgetQueuedInputDisposition;
  enqueueInput?: typeof enqueueInboundUserMessage;
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
    forgetQueuedInput = forgetQueuedInputDisposition,
    enqueueInput = enqueueInboundUserMessage,
  } = params;
  const identity = ordinaryInputIdentity(getInboundClientMessageId(incoming));
  let inputAcknowledged = false;
  const acknowledgeInput = (result: {
    accepted: boolean;
    disposition?: "started" | "queued";
    duplicate?: boolean;
    mayRecreateOwner?: () => boolean;
  }): void => {
    if (inputAcknowledged) return;
    inputAcknowledged = true;
    onInputAccepted?.(result);
  };
  const recoverRetainedQueuedInput = (): void => {
    const retry = () => {
      if (listener !== getActiveRuntime() || listener.intentionallyClosed)
        return;
      try {
        listener.restoreDurableQueuedInputs?.();
        scheduleQueuePump(runtime, socket, options, processQueuedTurn);
      } catch {
        const timer = setTimeout(retry, 1_000);
        timer.unref();
      }
    };
    setImmediate(retry);
  };

  runtime.pendingInboundDispatches += 1;
  runtime.messageQueue = runtime.messageQueue
    .then(async () => {
      if (listener !== getActiveRuntime() || listener.intentionallyClosed) {
        acknowledgeInput({ accepted: false });
        return;
      }
      const admission = reserveInputDisposition(runtime, identity);
      if (admission.kind === "duplicate") {
        const terminalConsumerId = incoming.terminalConsumerIds?.[0];
        acknowledgeInput({
          accepted: true,
          disposition: admission.disposition,
          duplicate: true,
          mayRecreateOwner: () =>
            terminalConsumerId
              ? attachTerminalConsumerToLiveAcceptedInput(
                  runtime,
                  identity,
                  terminalConsumerId,
                )
              : hasLiveAcceptedInputOwner(runtime, identity),
        });
        return;
      }
      if (admission.kind === "full") {
        acknowledgeInput({ accepted: false });
        return;
      }
      const reservation =
        admission.kind === "reserved" ? admission.reservation : undefined;
      const attributedIncoming = {
        ...incoming,
        ...(actingUserId && incoming.actingUserId !== actingUserId
          ? { actingUserId }
          : {}),
        ...(identity ? { durableInputIdentities: [identity] } : {}),
      };
      try {
        if (
          isRuntimeTeleportPending(
            listener,
            runtime.agentId,
            runtime.conversationId,
          )
        ) {
          rollbackInputDisposition(runtime, reservation);
          acknowledgeInput({ accepted: false });
          return;
        }
        if (shouldQueueInboundMessage(incoming)) {
          const committed = commitInputDisposition(
            runtime,
            reservation,
            "queued",
            { incoming: attributedIncoming, actingUserId },
          );
          let accepted = false;
          try {
            accepted =
              committed &&
              enqueueInput(runtime, attributedIncoming, actingUserId);
          } catch (error) {
            if (committed && !forgetQueuedInput(runtime, identity)) {
              recoverRetainedQueuedInput();
              acknowledgeInput({ accepted: true, disposition: "queued" });
              return;
            }
            throw error;
          }
          const durablyAccepted = committed && accepted;
          if (!durablyAccepted) {
            if (committed) {
              if (!forgetQueuedInput(runtime, identity)) {
                recoverRetainedQueuedInput();
                acknowledgeInput({ accepted: true, disposition: "queued" });
                return;
              }
            } else {
              rollbackInputDisposition(runtime, reservation);
            }
          }
          acknowledgeInput({
            accepted: durablyAccepted,
            ...(durablyAccepted ? { disposition: "queued" } : {}),
          });
          if (durablyAccepted) {
            scheduleQueuePump(runtime, socket, options, processQueuedTurn);
          }
          return;
        }

        emitListenerStatus(
          listener,
          options.onStatusChange,
          options.connectionId,
        );
        if (
          !commitInputDisposition(runtime, reservation, "started", {
            incoming: attributedIncoming,
            actingUserId,
          })
        ) {
          rollbackInputDisposition(runtime, reservation);
          acknowledgeInput({ accepted: false });
          return;
        }
        acknowledgeInput({ accepted: true, disposition: "started" });
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
      } catch (error) {
        rollbackInputDisposition(runtime, reservation);
        throw error;
      }
    })
    .catch((error: unknown) => {
      try {
        acknowledgeInput({ accepted: false });
      } catch (acknowledgementError) {
        trackListenerError(
          "listener_input_acknowledgement_failed",
          acknowledgementError,
          "listener_message_queue",
        );
      }
      trackListenerError(
        "listener_queued_input_failed",
        error,
        "listener_message_queue",
      );
      if (isDebugEnabled()) {
        console.error("[Listen] Error handling queued input:", error);
      }
      try {
        emitListenerStatus(
          listener,
          options.onStatusChange,
          options.connectionId,
        );
      } catch (statusError) {
        trackListenerError(
          "listener_status_callback_failed",
          statusError,
          "listener_message_queue",
        );
      }
      try {
        scheduleQueuePump(runtime, socket, options, processQueuedTurn);
      } catch (queuePumpError) {
        trackListenerError(
          "listener_queue_pump_schedule_failed",
          queuePumpError,
          "listener_message_queue",
        );
      }
    })
    .finally(() => {
      runtime.pendingInboundDispatches -= 1;
      evictConversationRuntimeIfIdle(runtime);
    });
}
