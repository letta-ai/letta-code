import { isTerminalConsumerId } from "@/types/turn-finished-protocol";
import type { InterruptedTurnRecord } from "./interrupted-turn-types";
import { isTeleportContinuation } from "./teleport-protocol-inbound";

export function isInputIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const identity = value as { domain?: unknown; id?: unknown };
  return (
    (identity.domain === "input" || identity.domain === "teleport") &&
    typeof identity.id === "string" &&
    identity.id.length > 0
  );
}

export function isTeleportIntent(
  value: unknown,
): value is NonNullable<InterruptedTurnRecord["teleport"]> {
  if (!value || typeof value !== "object") return false;
  const teleport = value as NonNullable<InterruptedTurnRecord["teleport"]>;
  return (
    typeof teleport.teleportId === "string" &&
    typeof teleport.connectionId === "string" &&
    (teleport.connectionGeneration === undefined ||
      typeof teleport.connectionGeneration === "string") &&
    typeof teleport.activeTurn === "boolean" &&
    typeof teleport.ready === "boolean" &&
    (teleport.intentRevision === undefined ||
      typeof teleport.intentRevision === "string") &&
    (teleport.committedRevision === undefined ||
      typeof teleport.committedRevision === "string") &&
    (teleport.readyRevision === undefined ||
      typeof teleport.readyRevision === "string") &&
    (teleport.continuation === undefined ||
      isTeleportContinuation(teleport.continuation))
  );
}

export function isInterruptedTurnRecord(
  value: unknown,
  file: string,
  path: (agentId: string, conversationId: string) => string,
): value is InterruptedTurnRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as InterruptedTurnRecord;
  const marker = record.recoveryClaimCompletion;
  return (
    typeof record.agentId === "string" &&
    typeof record.conversationId === "string" &&
    path(record.agentId, record.conversationId) === file &&
    Array.isArray(record.toolCallIds) &&
    record.toolCallIds.every((id) => typeof id === "string") &&
    (record.unstartedToolCallIds === undefined ||
      (Array.isArray(record.unstartedToolCallIds) &&
        record.unstartedToolCallIds.every((id) => typeof id === "string"))) &&
    Array.isArray(record.results) &&
    record.results.every(
      (result) => result && typeof result.tool_call_id === "string",
    ) &&
    (record.settledRecoveryEffects === undefined ||
      (Array.isArray(record.settledRecoveryEffects) &&
        record.settledRecoveryEffects.every(
          (effect) =>
            effect &&
            typeof effect.lineageId === "string" &&
            effect.lineageId.length > 0 &&
            effect.result &&
            typeof effect.result.tool_call_id === "string",
        ))) &&
    (record.durableInputIdentities === undefined ||
      (Array.isArray(record.durableInputIdentities) &&
        record.durableInputIdentities.every(isInputIdentity))) &&
    (record.terminalConsumerIds === undefined ||
      (Array.isArray(record.terminalConsumerIds) &&
        record.terminalConsumerIds.every(isTerminalConsumerId))) &&
    (record.actingUserId === undefined ||
      typeof record.actingUserId === "string") &&
    (marker === undefined ||
      (typeof marker.lineageId === "string" &&
        marker.lineageId.length > 0 &&
        (marker.state === "running" || marker.state === "pending") &&
        (marker.effectRevision === undefined ||
          typeof marker.effectRevision === "string") &&
        (marker.effectInputIdentities === undefined ||
          (Array.isArray(marker.effectInputIdentities) &&
            marker.effectInputIdentities.every(isInputIdentity))) &&
        (marker.effectToolCallIds === undefined ||
          (Array.isArray(marker.effectToolCallIds) &&
            marker.effectToolCallIds.every(
              (id) => typeof id === "string" && id.length > 0,
            ))) &&
        (marker.effectRunId === undefined ||
          marker.effectRunId === null ||
          typeof marker.effectRunId === "string") &&
        (marker.effectRequestOtid === undefined ||
          typeof marker.effectRequestOtid === "string") &&
        (marker.effectWorkingDirectory === undefined ||
          typeof marker.effectWorkingDirectory === "string") &&
        (marker.effectActingUserId === undefined ||
          marker.effectActingUserId === null ||
          typeof marker.effectActingUserId === "string") &&
        (marker.effectResults === undefined ||
          (Array.isArray(marker.effectResults) &&
            marker.effectResults.every(
              (result) => result && typeof result.tool_call_id === "string",
            ))) &&
        (marker.effectUnstartedToolCallIds === undefined ||
          (Array.isArray(marker.effectUnstartedToolCallIds) &&
            marker.effectUnstartedToolCallIds.every(
              (id) => typeof id === "string",
            ))) &&
        (marker.effectTerminalConsumerIds === undefined ||
          (Array.isArray(marker.effectTerminalConsumerIds) &&
            marker.effectTerminalConsumerIds.every(isTerminalConsumerId))) &&
        (marker.effectTeleport === undefined ||
          isTeleportIntent(marker.effectTeleport)) &&
        (marker.independentSuccessor === undefined ||
          typeof marker.independentSuccessor === "boolean") &&
        (marker.state !== "pending" || Boolean(marker.effectRevision)))) &&
    (record.teleport === undefined || isTeleportIntent(record.teleport)) &&
    typeof record.requestOtid === "string" &&
    typeof record.workingDirectory === "string"
  );
}
