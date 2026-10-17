/**
 * Input-frame routing: acknowledgement, the pre-commit originator admission
 * gate, teleport-continue admission, approval responses, queue/dispatch, and
 * the durable input ledger. Split out of message-router.ts so both modules
 * stay under the source-file size limit; the router itself only dispatches.
 */

import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { gateMcpOriginatorDeliveryAdmission } from "@/agent/mcp-originator-tokens";
import type { InputCommand } from "@/types/protocol_v2";
import {
  createIncomingMessage,
  dispatchInboundMessageWhenReady,
} from "./inbound-dispatch";
import {
  enqueueInboundUserMessage,
  getInboundClientMessageId,
} from "./inbound-queue";
import {
  acknowledgeAdmissionDuplicate,
  acknowledgeIfAlreadyAdmitted,
  acknowledgeInputFrame,
  type InputAckArgs,
  type InputAckExtras,
  MCP_ORIGINATOR_DENIED_PERMANENT_ABORT_REASON,
} from "./input-ack";
import {
  commitInputDisposition,
  forgetQueuedInputDisposition,
  ordinaryInputIdentity,
  reserveInputDisposition,
} from "./input-disposition";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import type { MessageRouterParams } from "./message-router-types";
import { logV2Command } from "./protocol-logging";
import {
  scheduleQueuePump,
  shouldProcessInboundMessageDirectly,
  shouldQueueInboundMessage,
} from "./queue";
import { emitLoopErrorNotice } from "./recoverable-notices";
import { getActiveRuntime } from "./runtime";
import { validateResponseFormat } from "./structured-output";
import { isRuntimeTeleportPending } from "./teleport";
import { admitTeleportContinueInput } from "./teleport-continue-input";
import type { IncomingMessage, ListenerConnectionId } from "./types";

export interface InputFrameRouterDeps
  extends Pick<
    MessageRouterParams,
    | "runtime"
    | "socket"
    | "opts"
    | "processQueuedTurn"
    | "getOrCreateScopedRuntime"
    | "handleApprovalResponseInput"
    | "stampInboundUserMessageOtids"
    | "safeSocketSend"
    | "runDetachedListenerTask"
    | "trackListenerError"
  > {
  connectionId: ListenerConnectionId;
  parsed: InputCommand;
  processIncomingMessage: NonNullable<
    MessageRouterParams["processIncomingMessage"]
  >;
}

export async function routeInputFrame(
  deps: InputFrameRouterDeps,
): Promise<void> {
  const {
    runtime,
    socket,
    connectionId,
    opts,
    parsed,
    processQueuedTurn,
    getOrCreateScopedRuntime,
    handleApprovalResponseInput,
    stampInboundUserMessageOtids,
    safeSocketSend,
    runDetachedListenerTask,
    trackListenerError,
    processIncomingMessage,
  } = deps;
  // Frame-scoped gate extras: set by gateInputOriginatorAdmission below so
  // every later ack for this frame inherits the gate's verdict (pre-gated
  // install or the non-retryable abort reason) instead of re-deciding.
  let ackExtras: InputAckExtras | undefined;
  // Binds the socket and frame; ack arguments pass through verbatim, with
  // the gate extras appended positionally (never spread: optional tuple
  // holes would shift the trailing extras into the wrong slot).
  const acknowledgeInput = (...args: InputAckArgs): void =>
    acknowledgeInputFrame(
      safeSocketSend,
      socket,
      parsed,
      args[0],
      args[1],
      args[2],
      args[3],
      args[4],
      ackExtras,
    );
  const ackTransport = { safeSocketSend, socket, frame: parsed };
  if (runtime !== getActiveRuntime() || runtime.intentionallyClosed) {
    logV2Command(opts, "Dropping input: runtime mismatch or closed");
    acknowledgeInput(false, "Runtime is no longer active");
    return;
  }
  // Pre-commit originator admission gate (evil-shub round-8 P1; the SINGLE
  // admission decision as of round-9 P1): a delivery denied by the durable
  // authority must never commit, enqueue, or start work — the ack-time
  // recordMcpOriginatorDelivery used to be the ONLY gate, and it ran after
  // the durable commit. "denied_retryable" (degraded store / failed
  // transaction) returns with NO ack so Cloud redelivers and retries the
  // whole admission; "denied_permanent" (stale/retired/malformed) rejects
  // the frame — redelivering identical bytes would loop forever. On admit,
  // the parsed delivery is captured for the ack path, which installs the
  // volatile half only: no second admission transaction after commit, so a
  // retirement landing in the gate→ack gap cannot flip committed work to
  // denied (it is fenced at use time by the authority recheck instead).
  const gateInputOriginatorAdmission = (): boolean => {
    const gate = gateMcpOriginatorDeliveryAdmission(parsed);
    if (gate.verdict === "denied_retryable") {
      console.error(
        "[message-router] originator admission is retryable-denied; leaving the input uncommitted and unacked so Cloud redelivers",
      );
      return false;
    }
    if (gate.verdict === "denied_permanent") {
      // Mark the rejection non-retryable on the wire (evil-shub round-9 P2):
      // without an abortReason, Cloud treats an accepted:false ack as
      // retryable and remint/redelivers bytes that can never be admitted.
      ackExtras = {
        abortReason: MCP_ORIGINATOR_DENIED_PERMANENT_ABORT_REASON,
      };
      console.error(
        "[message-router] originator admission is permanently denied; rejecting the input without committing work",
      );
      acknowledgeInput(
        false,
        "Originator authority for this input was permanently rejected",
      );
      return false;
    }
    // Admitted (or unstamped): the ack installs exactly this delivery with
    // no re-admission; `null` records that the gate ran for an unstamped
    // frame so the ack skips the legacy record path too.
    ackExtras = { preGated: gate.delivery ?? null };
    return true;
  };
  if (parsed.payload.kind === "teleport_continue") {
    const teleportAgentId = parsed.runtime.agent_id;
    if (!teleportAgentId) {
      acknowledgeInput(false, "Teleport requires an agent-backed runtime");
      return;
    }
    if (!gateInputOriginatorAdmission()) {
      return;
    }
    admitTeleportContinueInput({
      listener: runtime,
      scopedRuntime: getOrCreateScopedRuntime(
        runtime,
        parsed.runtime.agent_id,
        parsed.runtime.conversation_id,
      ),
      connectionId,
      agentId: teleportAgentId,
      conversationId: parsed.runtime.conversation_id,
      payload: parsed.payload,
      originatorSuperRunId: parsed.super_run_id,
      onStatusChange: opts.onStatusChange,
      acknowledgeInput,
      runDetachedListenerTask,
      processIncomingMessage,
    });
    return;
  }
  if (parsed.payload.kind === "approval_response") {
    const handled = await handleApprovalResponseInput(runtime, {
      runtime: parsed.runtime,
      response: parsed.payload,
      connectionId,
      socket,
      opts: {
        onStatusChange: opts.onStatusChange,
        connectionId: opts.connectionId,
      },
      processQueuedTurn,
    });
    acknowledgeInput(
      handled,
      handled ? undefined : "Approval request is no longer pending",
    );
    return;
  }
  const inputPayload = parsed.payload;
  if (inputPayload.kind !== "create_message") {
    emitLoopErrorNotice(socket, runtime, {
      message: `Unsupported input payload kind: ${String((inputPayload as { kind?: unknown }).kind)}`,
      stopReason: "error",
      isTerminal: false,
      agentId: parsed.runtime.agent_id,
      conversationId: parsed.runtime.conversation_id,
    });
    acknowledgeInput(false, "Unsupported input payload kind");
    return;
  }
  const error = validateResponseFormat(inputPayload.response_format);
  if (error) {
    acknowledgeInput(false, error);
    return;
  }
  const incoming = createIncomingMessage(
    parsed.runtime,
    inputPayload,
    connectionId,
    parsed,
  );
  const hasApprovalPayload = incoming.messages.some(
    (payload): payload is ApprovalCreate =>
      "type" in payload && payload.type === "approval",
  );
  if (hasApprovalPayload) {
    emitLoopErrorNotice(socket, runtime, {
      message:
        "Protocol violation: approval payloads are not allowed in input.kind=create_message. Use input.kind=approval_response.",
      stopReason: "error",
      isTerminal: false,
      agentId: parsed.runtime.agent_id,
      conversationId: parsed.runtime.conversation_id,
    });
    acknowledgeInput(false, "Approval payloads require approval_response");
    return;
  }

  const scopedRuntime = getOrCreateScopedRuntime(
    runtime,
    incoming.agentId,
    incoming.conversationId,
  );

  const processIncomingMessageDirectly = (
    directIncoming: IncomingMessage,
  ): void => {
    dispatchInboundMessageWhenReady({
      listener: runtime,
      runtime: scopedRuntime,
      incoming: directIncoming,
      socket,
      options: opts,
      processQueuedTurn,
      processIncomingMessage,
      actingUserId: parsed.runtime.acting_user_id,
      trackListenerError,
      onInputAccepted: (result) =>
        acknowledgeInput(
          result.accepted,
          result.accepted ? undefined : "Input was rejected by the queue",
          result.disposition,
          result.duplicate ? "refresh" : undefined,
          result.mayRecreateOwner,
        ),
    });
  };

  if (shouldQueueInboundMessage(incoming)) {
    const stampedIncoming = stampInboundUserMessageOtids(incoming);
    const identity = ordinaryInputIdentity(
      getInboundClientMessageId(stampedIncoming),
    );
    if (acknowledgeIfAlreadyAdmitted(ackTransport, scopedRuntime, identity)) {
      return;
    }
    if (
      isRuntimeTeleportPending(
        runtime,
        scopedRuntime.agentId,
        scopedRuntime.conversationId,
      )
    ) {
      acknowledgeInput(false, "Conversation is switching computers");
      return;
    }
    if (!gateInputOriginatorAdmission()) {
      return;
    }
    if (shouldProcessInboundMessageDirectly(scopedRuntime, stampedIncoming)) {
      processIncomingMessageDirectly(stampedIncoming);
      return;
    }

    const admission = reserveInputDisposition(scopedRuntime, identity);
    if (admission.kind === "duplicate") {
      acknowledgeAdmissionDuplicate(
        ackTransport,
        scopedRuntime,
        identity,
        admission.disposition,
      );
      return;
    }
    if (admission.kind === "full") {
      acknowledgeInput(false, "Stable input ledger is at capacity");
      return;
    }
    const reservation =
      admission.kind === "reserved" ? admission.reservation : undefined;
    const durableIncoming = identity
      ? { ...stampedIncoming, durableInputIdentities: [identity] }
      : stampedIncoming;
    try {
      const committed = commitInputDisposition(
        scopedRuntime,
        reservation,
        "queued",
        {
          incoming: durableIncoming,
          actingUserId: parsed.runtime.acting_user_id,
        },
      );
      let enqueued = false;
      try {
        enqueued =
          committed &&
          enqueueInboundUserMessage(
            scopedRuntime,
            durableIncoming,
            parsed.runtime.acting_user_id,
          );
      } catch (error) {
        if (committed) forgetQueuedInputDisposition(scopedRuntime, identity);
        throw error;
      }
      const durablyAccepted = committed && enqueued;
      if (durablyAccepted) {
        scheduleQueuePump(scopedRuntime, socket, opts, processQueuedTurn);
      } else if (committed) {
        forgetQueuedInputDisposition(scopedRuntime, identity);
      } else {
        rollbackInputDisposition(scopedRuntime, reservation);
      }
      acknowledgeInput(
        durablyAccepted,
        durablyAccepted
          ? undefined
          : "Input was rejected by the queue or durable ledger",
        durablyAccepted ? "queued" : undefined,
      );
    } catch (error) {
      rollbackInputDisposition(scopedRuntime, reservation);
      throw error;
    }
    return;
  }

  if (!gateInputOriginatorAdmission()) {
    return;
  }
  processIncomingMessageDirectly(incoming);
  return;
}
