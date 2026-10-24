import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  rebuildInputWithFreshDenials,
  STALE_APPROVAL_RECOVERY_DENIAL_REASON,
} from "@/agent/approval-recovery";
import {
  BUSY_RUN_POLL_INTERVAL_MS,
  waitForBusyRunRetry,
} from "@/agent/busy-run-wait";
import { getResumeDataFromBackend } from "@/agent/check-approval";
import { extractConversationBusyRunId } from "@/agent/turn-recovery-policy";
import { getBackend } from "@/backend";
import { safeJsonParseOr } from "@/cli/helpers/safe-json-parse";

/** Shared context parsing for pre-stream and post-stream approval recovery. */
export function analyzeRecoveredApprovalContexts<T>(
  approvals: ReadonlyArray<{ toolName: string; toolArgs: string }>,
  analyze: (name: string, args: Record<string, unknown>) => Promise<T>,
): Promise<T[]> {
  return Promise.all(
    approvals.map((approval) =>
      analyze(
        approval.toolName,
        safeJsonParseOr<Record<string, unknown>>(approval.toolArgs, {}),
      ),
    ),
  );
}

/** A rejected prompt is not authority to deny another client's approvals. */
export function createBusyInputApprovalGuard(
  deps: {
    now?: () => number;
    protectedInput?: boolean;
    wait?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  } = {},
) {
  const now = deps.now ?? Date.now;
  const wait =
    deps.wait ?? ((delay, signal) => waitForBusyRunRetry("", delay, signal));
  let protectedInput = deps.protectedInput === true;
  let deadline: number | null = null;
  let waits = 0;
  return {
    noteConflict(detail: string) {
      if (extractConversationBusyRunId(detail)) protectedInput = true;
    },
    reset() {
      protectedInput = false;
      deadline = null;
      waits = 0;
    },
    async wait(signal: AbortSignal): Promise<boolean> {
      if (!protectedInput) return false;
      signal.throwIfAborted();
      deadline ??= now() + 300_000;
      if (now() >= deadline || waits >= 60) {
        throw new Error(
          "Conversation is still waiting for another client's approval",
        );
      }
      waits += 1;
      await wait(Math.min(BUSY_RUN_POLL_INTERVAL_MS, deadline - now()), signal);
      return true;
    },
  };
}

/** Existing orphan-approval recovery, only for inputs not behind a foreign run. */
export async function recoverTuiPendingApprovalInput(
  input: Array<MessageCreate | ApprovalCreate>,
  agentId: string,
  conversationId: string,
): Promise<Array<MessageCreate | ApprovalCreate>> {
  try {
    const agent = await getBackend().retrieveAgent(agentId);
    const { pendingApprovals } = await getResumeDataFromBackend(
      agent,
      conversationId,
    );
    return rebuildInputWithFreshDenials(
      input,
      pendingApprovals ?? [],
      STALE_APPROVAL_RECOVERY_DENIAL_REASON,
    );
  } catch {
    return rebuildInputWithFreshDenials(input, [], "");
  }
}
