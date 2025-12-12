import type Letta from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";

import type { createBuffers } from "../cli/helpers/accumulator";
import type { ApprovalRequest, DrainResult } from "../cli/helpers/stream";
import { drainStreamWithResume } from "../cli/helpers/stream";
import { getResumeData } from "./check-approval";

export async function resyncPendingApprovals(
  client: Letta,
  agent: AgentState,
): Promise<ApprovalRequest[]> {
  const { pendingApprovals } = await getResumeData(client, agent);
  return pendingApprovals ?? [];
}

export async function findNewestActiveBackgroundRunId(
  client: Letta,
  agentId: string,
): Promise<string | null> {
  const runsPage = await client.runs.list({
    active: true,
    agent_id: agentId,
    background: true,
    limit: 10,
  });

  const runs = runsPage.items ?? [];
  if (runs.length === 0) return null;

  // Prefer the most recently created run.
  runs.sort((a, b) => {
    const aTs = Date.parse((a as { created_at?: string }).created_at ?? "") || 0;
    const bTs = Date.parse((b as { created_at?: string }).created_at ?? "") || 0;
    return bTs - aTs;
  });

  return runs[0]?.id ?? null;
}

export type StaleApprovalRecovery =
  | { kind: "pending_approval"; approvals: ApprovalRequest[] }
  | { kind: "relatched"; result: DrainResult }
  | { kind: "noop" };

export async function recoverFromStaleApproval(
  client: Letta,
  agentId: string,
  buffers: ReturnType<typeof createBuffers>,
  refresh: () => void,
  abortSignal: AbortSignal | undefined,
  opts: {
    lastKnownRunId?: string | null;
    lastKnownSeqId?: number | null;
  } = {},
): Promise<StaleApprovalRecovery> {
  const agent = await client.agents.retrieve(agentId);
  const approvals = await resyncPendingApprovals(client, agent);
  if (approvals.length > 0) {
    return { kind: "pending_approval", approvals };
  }

  const runId = opts.lastKnownRunId ?? (await findNewestActiveBackgroundRunId(client, agentId));
  if (!runId) return { kind: "noop" };

  const stream = await client.runs.messages.stream(
    runId,
    {
      starting_after: opts.lastKnownSeqId ?? undefined,
      batch_size: 1000,
    },
    { maxRetries: 0 },
  );

  const result = await drainStreamWithResume(stream, buffers, refresh, abortSignal);
  return { kind: "relatched", result };
}
