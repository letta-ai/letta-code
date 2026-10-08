import { randomUUID } from "node:crypto";
import type { ApprovalResult } from "@/agent/approval-execution";
import {
  type recordListenerWork,
  recordListenerWorkRetriably,
} from "./interrupted-turn-record";
import type {
  ConversationRuntime,
  IncomingMessage,
  InputIdentity,
} from "./types";

export type TurnContinuationMetadata = {
  lastExecutionResults: ApprovalResult[] | null;
  lastExecutingToolCallIds: string[];
  lastNeedsUserInputToolCallIds: string[];
};

export async function checkpointTurnInputOwnership(
  runtime: ConversationRuntime,
  ownership: ReturnType<typeof createTurnDurabilityOwnership>,
  expectedRevision?: string,
  actingUserId?: string,
  recoveryLineageId?: string,
  recoveryEvidenceWriter?: (
    ...args: Parameters<typeof recordListenerWork>
  ) => unknown | Promise<unknown>,
): Promise<string | undefined> {
  const update = {
    durableInputIdentities: [...ownership.durableInputIdentities],
    terminalConsumerIds: [...ownership.terminalConsumerIds],
    actingUserId,
  };
  if (recoveryEvidenceWriter) {
    const revision = await recoveryEvidenceWriter(
      runtime,
      update,
      "run_observed",
      expectedRevision,
      recoveryLineageId,
    );
    return typeof revision === "string" ? revision : undefined;
  }
  return recordListenerWorkRetriably(
    runtime,
    update,
    "run_observed",
    expectedRevision,
    recoveryLineageId,
  );
}

/** Turn-owned metadata survives every generic approval continuation. */
export function createTurnDurabilityOwnership() {
  const resultsByToolCallId = new Map<string, ApprovalResult>();
  const executingToolCallIds = new Set<string>();
  const needsUserInputToolCallIds = new Set<string>();
  const durableInputIdentities = new Map<string, InputIdentity>();
  const terminalConsumerIds = new Set<string>();
  return {
    terminalTurnId: `turn-${randomUUID()}`,
    recordInput(
      input: Pick<
        IncomingMessage,
        "durableInputIdentities" | "terminalConsumerIds"
      >,
    ): void {
      for (const identity of input.durableInputIdentities ?? []) {
        durableInputIdentities.set(
          `${identity.domain}\0${identity.id}`,
          identity,
        );
      }
      for (const consumerId of input.terminalConsumerIds ?? []) {
        terminalConsumerIds.add(consumerId);
      }
    },
    get durableInputIdentities(): InputIdentity[] {
      return [...durableInputIdentities.values()];
    },
    get terminalConsumerIds(): string[] {
      return [...terminalConsumerIds];
    },
    record(metadata: TurnContinuationMetadata): TurnContinuationMetadata {
      for (const result of metadata.lastExecutionResults ?? []) {
        resultsByToolCallId.set(result.tool_call_id, result);
        executingToolCallIds.delete(result.tool_call_id);
        needsUserInputToolCallIds.delete(result.tool_call_id);
      }
      for (const toolCallId of metadata.lastExecutingToolCallIds) {
        if (!resultsByToolCallId.has(toolCallId)) {
          executingToolCallIds.add(toolCallId);
        }
      }
      for (const toolCallId of metadata.lastNeedsUserInputToolCallIds) {
        if (!resultsByToolCallId.has(toolCallId)) {
          needsUserInputToolCallIds.add(toolCallId);
        }
      }
      return {
        lastExecutionResults: resultsByToolCallId.size
          ? [...resultsByToolCallId.values()]
          : null,
        lastExecutingToolCallIds: [...executingToolCallIds],
        lastNeedsUserInputToolCallIds: [...needsUserInputToolCallIds],
      };
    },
  };
}
