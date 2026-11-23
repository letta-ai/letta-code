import type { ApprovalResult } from "@/agent/approval-execution";
import type { TeleportContinuation } from "@/types/protocol_v2";
import type { InputIdentity, InterruptedTerminalAuthority } from "./types";

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
    intentRevision?: string;
    committedRevision?: string;
    terminalAuthority?: InterruptedTerminalAuthority;
    preserveSuccessorWork?: boolean;
    readyRevision?: string;
  };
  actingUserId?: string;
  recoveryClaimCompletion?: {
    lineageId: string;
    state: "running" | "pending";
    effectRevision?: string;
    effectInputIdentities?: InputIdentity[];
    effectToolCallIds?: string[];
    effectRunId?: string | null;
    effectRequestOtid?: string;
    effectWorkingDirectory?: string;
    effectActingUserId?: string | null;
    effectResults?: ApprovalResult[];
    effectUnstartedToolCallIds?: string[];
    effectTerminalConsumerIds?: string[];
    effectTeleport?: InterruptedTurnRecord["teleport"];
    independentSuccessor?: boolean;
  };
  agentId: string;
  conversationId: string;
  runId: string | null;
  toolCallIds: string[];
  unstartedToolCallIds?: string[];
  results: ApprovalResult[];
  settledRecoveryEffects?: Array<{
    lineageId: string;
    result: ApprovalResult;
  }>;
  requestOtid: string;
  workingDirectory: string;
  durableInputIdentities?: InputIdentity[];
  terminalConsumerIds?: string[];
}
