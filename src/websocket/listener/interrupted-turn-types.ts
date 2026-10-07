import type { ApprovalResult } from "@/agent/approval-execution";
import type { TeleportContinuation } from "@/types/protocol_v2";
import type { InputIdentity } from "./types";

export interface InterruptedTurnRecord {
  revision?: string;
  teleportId?: string;
  teleport?: {
    teleportId: string;
    connectionId: string;
    connectionGeneration?: string;
    activeTurn: boolean;
    continuation?: TeleportContinuation;
    ready: boolean;
    /** Revision created when this exact intent was first journaled. */
    intentRevision?: string;
    /** Interrupted-record revision captured by the durable terminal owner. */
    committedRevision?: string;
    /** Exact record revision which first published this ready handoff. */
    readyRevision?: string;
  };
  actingUserId?: string;
  recoveryClaimCompletion?: {
    lineageId: string;
    state: "running" | "pending";
    /** Exact predecessor revision whose completed effects this marker covers. */
    effectRevision?: string;
    /** Input identities owned by that predecessor, retained across a successor write. */
    effectInputIdentities?: InputIdentity[];
    /** Complete tool namespace owned by that predecessor recovery lineage. */
    effectToolCallIds?: string[];
    effectRunId?: string | null;
    effectRequestOtid?: string;
    effectWorkingDirectory?: string;
    effectActingUserId?: string | null;
    effectResults?: ApprovalResult[];
    effectUnstartedToolCallIds?: string[];
    effectTerminalConsumerIds?: string[];
    effectTeleport?: InterruptedTurnRecord["teleport"];
    /** A write outside this recovery lineage has added genuine successor work. */
    independentSuccessor?: boolean;
  };
  agentId: string;
  conversationId: string;
  runId: string | null;
  toolCallIds: string[];
  /** Approved tools which have not crossed their own execution boundary. */
  unstartedToolCallIds?: string[];
  results: ApprovalResult[];
  /** Exact settled effects that survive an independent successor snapshot. */
  settledRecoveryEffects?: Array<{
    lineageId: string;
    result: ApprovalResult;
  }>;
  requestOtid: string;
  workingDirectory: string;
  durableInputIdentities?: InputIdentity[];
  terminalConsumerIds?: string[];
}
