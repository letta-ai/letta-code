import { randomUUID } from "node:crypto";
import { getBackend } from "@/backend";
import type { Buffers } from "@/cli/helpers/accumulator";
import { debugWarn } from "@/utils/debug";

const ACTIVE_BLOCKING_RUN_STATUSES = new Set(["created", "running"]);
const BUSY_RUN_POLL_INTERVAL_MS = 5000;

export function showBusyWaitStatus(
  buffers: Buffers,
  message: string,
  refresh: () => void,
): () => void {
  const statusId = `status-${randomUUID()}`;
  buffers.byId.set(statusId, {
    kind: "status",
    id: statusId,
    lines: [message],
  });
  buffers.order.push(statusId);
  refresh();

  return () => {
    buffers.byId.delete(statusId);
    buffers.order = buffers.order.filter((id) => id !== statusId);
    refresh();
  };
}

function isBlockingRunActive(status: unknown): boolean {
  return typeof status === "string" && ACTIVE_BLOCKING_RUN_STATUSES.has(status);
}

async function sleepWithAbort(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) throw abortSignal.reason;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortSignal?.reason);
    };
    abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait for a server-reported blocking run without consuming that run's output. */
export async function waitForBlockingRunToSettle(
  runId: string,
  abortSignal?: AbortSignal,
  pollIntervalMs = BUSY_RUN_POLL_INTERVAL_MS,
): Promise<"settled" | "unavailable"> {
  while (true) {
    if (abortSignal?.aborted) throw abortSignal.reason;

    let run: Awaited<ReturnType<ReturnType<typeof getBackend>["retrieveRun"]>>;
    try {
      run = await getBackend().retrieveRun(
        runId,
        abortSignal ? { signal: abortSignal } : undefined,
      );
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? error;
      debugWarn(
        "busy-run-recovery",
        "Unable to retrieve blocking run %s: %s",
        runId,
        error instanceof Error ? error.message : String(error),
      );
      return "unavailable";
    }

    if (!isBlockingRunActive(run.status)) return "settled";
    await sleepWithAbort(pollIntervalMs, abortSignal);
  }
}
