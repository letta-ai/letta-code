import type { InputTeleportContinuePayload } from "@/types/teleport-protocol";
import { getOrCreateProcessTransport } from "./connection";
import {
  commitInputDisposition,
  reserveInputDisposition,
  teleportInputIdentity,
} from "./input-disposition";
import { hasLiveAcceptedInputOwnerWithOriginatorRetirement } from "./input-disposition-ownership";
import { rollbackInputDisposition } from "./input-disposition-rollback";
import {
  buildTeleportContinuationMessages,
  clearExpectedInboundTeleport,
  clearPriorReadyTeleports,
  isInboundTeleportExpected,
} from "./teleport";
import type { handleIncomingMessage } from "./turn";
import type {
  ConversationRuntime,
  ListenerConnectionId,
  ListenerRuntime,
  StartListenerOptions,
} from "./types";

export type AcknowledgeInput = (
  accepted: boolean,
  error?: string,
  disposition?: "started" | "queued",
  deliveryHandling?: "create" | "refresh",
  mayRecreateOwner?: () => boolean,
) => void;

export function admitTeleportContinueInput(params: {
  listener: ListenerRuntime;
  scopedRuntime: ConversationRuntime;
  connectionId: ListenerConnectionId;
  agentId: string;
  conversationId: string;
  payload: InputTeleportContinuePayload;
  originatorSuperRunId?: string;
  onStatusChange: StartListenerOptions["onStatusChange"];
  acknowledgeInput: AcknowledgeInput;
  runDetachedListenerTask: (
    commandName: string,
    task: () => Promise<void>,
  ) => void;
  processIncomingMessage: typeof handleIncomingMessage;
  commitDisposition?: typeof commitInputDisposition;
}): void {
  const {
    listener,
    scopedRuntime,
    connectionId,
    agentId,
    conversationId,
    payload,
    acknowledgeInput,
  } = params;
  const teleportId = payload.teleport_id;
  if (
    isInboundTeleportExpected(scopedRuntime) &&
    scopedRuntime.expectedTeleportId !== teleportId
  ) {
    acknowledgeInput(
      false,
      "Teleport continuation does not match the expected handoff",
    );
    return;
  }
  const admission = reserveInputDisposition(
    scopedRuntime,
    teleportInputIdentity(teleportId),
  );
  if (admission.kind === "duplicate") {
    acknowledgeInput(true, undefined, admission.disposition, "refresh", () =>
      hasLiveAcceptedInputOwnerWithOriginatorRetirement(
        scopedRuntime,
        teleportInputIdentity(teleportId),
      ),
    );
    return;
  }
  if (admission.kind === "full") {
    acknowledgeInput(
      false,
      admission.reason ?? "Stable input ledger is at capacity",
    );
    return;
  }
  const reservation =
    admission.kind === "reserved" ? admission.reservation : undefined;
  try {
    if (scopedRuntime.isProcessing) {
      rollbackInputDisposition(scopedRuntime, reservation);
      acknowledgeInput(false, "Destination runtime is already processing");
      return;
    }
    clearPriorReadyTeleports({
      listener,
      agentId,
      conversationId,
      currentTeleportId: teleportId,
    });
    const identity = teleportInputIdentity(teleportId);
    const continuationInput = {
      type: "message" as const,
      connectionId,
      agentId,
      conversationId,
      clientPreferences: payload.client_preferences,
      ...(params.originatorSuperRunId
        ? { mcpOriginatorSuperRunId: params.originatorSuperRunId }
        : {}),
      messages: buildTeleportContinuationMessages({
        teleportId,
        approvals: payload.continuation?.approvals,
      }),
      durableInputIdentities: [identity],
      ...(payload.continuation?.terminal_consumer_ids?.length
        ? {
            terminalConsumerIds: [
              ...new Set(payload.continuation.terminal_consumer_ids),
            ],
          }
        : {}),
    };
    if (
      !(params.commitDisposition ?? commitInputDisposition)(
        scopedRuntime,
        reservation,
        "started",
        {
          incoming: continuationInput,
        },
      )
    ) {
      rollbackInputDisposition(scopedRuntime, reservation);
      acknowledgeInput(
        false,
        "Stable input disposition could not be persisted",
      );
      return;
    }
    clearExpectedInboundTeleport(scopedRuntime);
    acknowledgeInput(true, undefined, "started", "refresh");
    params.runDetachedListenerTask("teleport_continue", async () => {
      await params.processIncomingMessage(
        continuationInput,
        getOrCreateProcessTransport(listener),
        scopedRuntime,
        params.onStatusChange,
        connectionId,
      );
    });
  } catch (error) {
    rollbackInputDisposition(scopedRuntime, reservation);
    throw error;
  }
}
