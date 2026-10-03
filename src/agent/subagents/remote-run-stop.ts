import { getBackend } from "@/backend";
import {
  type EnqueueReceipt,
  type ExactSuperRun,
  getExactSuperRun,
} from "@/backend/api/conversation-enqueue";

export type RemoteStopStatus = "stopped" | "unconfirmed";

interface RemoteRunStopDeps {
  exact: (agentId: string, superRunId: string) => Promise<ExactSuperRun>;
  cancelRun: (agentId: string, runId: string) => Promise<unknown>;
  runStatus: (runId: string) => Promise<string | null | undefined>;
  sleep: (ms: number) => Promise<void>;
  checks: number;
}

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "cancelled"]);

function isTerminalSuperRun(run: ExactSuperRun): boolean {
  return (
    run.status === "COM" ||
    run.status === "CAN" ||
    Boolean(run.completed_at || run.cancelled_at || run.errored_at)
  );
}

/** Cancel the receipt's Cloud runs, then briefly check that they are terminal. */
export async function stopRemoteRuns(
  receipt: EnqueueReceipt,
  overrides: Partial<RemoteRunStopDeps> = {},
): Promise<RemoteStopStatus> {
  const signal = AbortSignal.timeout(10_000);
  const deps: RemoteRunStopDeps = {
    exact: (agentId, superRunId) =>
      getExactSuperRun(agentId, superRunId, signal),
    cancelRun: (agentId, runId) => getBackend().cancelRun(agentId, runId),
    runStatus: async (runId) =>
      (await getBackend().retrieveRun(runId, { signal })).status,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    checks: 6,
    ...overrides,
  };
  const cancelRequested = new Set<string>();
  for (let check = 0; check < deps.checks; check++) {
    if (check > 0) await deps.sleep(500);
    try {
      const superRun = await deps.exact(receipt.agent_id, receipt.super_run_id);
      const uncancelled = superRun.run_ids.filter(
        (runId) => !cancelRequested.has(runId),
      );
      await Promise.allSettled(
        uncancelled.map(async (runId) => {
          await deps.cancelRun(receipt.agent_id, runId);
          cancelRequested.add(runId);
        }),
      );
      if (!isTerminalSuperRun(superRun)) continue;
      const statuses = await Promise.all(superRun.run_ids.map(deps.runStatus));
      if (statuses.every((status) => TERMINAL_RUN_STATUSES.has(status ?? "")))
        return "stopped";
    } catch {
      // Unreadable status is unconfirmed; keep checking until the budget ends.
    }
  }
  return "unconfirmed";
}
