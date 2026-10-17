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

/**
 * Admit one `teleport_continue` into its destination runtime.
 *
 * The teleport id is admitted in its own ledger domain, so a client message id
 * can neither mark a continuation as already-delivered nor be suppressed by
 * one. Any throw after admission releases the uncommitted reservation, keeping
 * the cloud's retry of the same teleport id admissible.
 */
export function admitTeleportContinueInput(params: {
  listener: ListenerRuntime;
  scopedRuntime: ConversationRuntime;
  connectionId: ListenerConnectionId;
  agentId: string;
  conversationId: string;
  payload: InputTeleportContinuePayload;
  /**
   * Originator super run id from the top-level frame (when present). Threaded
   * onto the continuation so the turn finalizer can retire the run's token
   * entry — including an entry a duplicate-branch ACK recreated from the live
   * teleport disposition (evil-shub round 4: a recreated entry whose
   * continuation carries no originator id is orphaned until TTL).
   */
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
    // Duplicate re-ack: refresh-only. The durable ledger is the authority on
    // whether this input still has a live owner whose token entry may be
    // recreated after a crash (a terminal tombstone must not qualify), AND
    // the persisted continuation must carry the owner id needed to retire a
    // recreated entry — a pre-owner-id (650eb75f) record cannot, so its
    // duplicate fails closed and the continuation runs headerless rather
    // than orphaning a recreated token (evil-shub round-5 P2).
    acknowledgeInput(true, undefined, admission.disposition, "refresh", () =>
      hasLiveAcceptedInputOwnerWithOriginatorRetirement(
        scopedRuntime,
        teleportInputIdentity(teleportId),
      ),
    );
    return;
  }
  if (admission.kind === "full") {
    acknowledgeInput(false, "Stable input ledger is at capacity");
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
    // MCP originator delivery: refresh-only, and NO recreate predicate. A
    // teleport continuation creates no new token owner here: the disposition
    // committed above would make a live-owner predicate vacuously true, so a
    // token riding this frame may re-assert an existing entry but must never
    // create one. Crash recovery does not need a hatch here: a post-crash
    // redelivery finds the durable disposition and takes the duplicate
    // branch, which gates recreation correctly — and the continuation's
    // threaded mcpOriginatorSuperRunId lets its finalizer retire that
    // recreated entry instead of orphaning it.
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
