import { getBackend } from "@/backend";
import { extractConversationBusyRunId } from "./turn-recovery-policy";

export const BUSY_RUN_POLL_INTERVAL_MS = 5000;
const BUSY_RUN_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);
const ACTIVE_RUN_STATUSES = new Set(["created", "running", "pending"]);

type BlockingRunWaitResult = "settled" | "timed_out" | "unavailable";
type WaitDependencies = {
  retrieveRun?: ReturnType<typeof getBackend>["retrieveRun"];
  timeoutMs?: number;
  pollIntervalMs?: number;
};

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  signal?.throwIfAborted();
}

export async function waitForBlockingRunToSettle(
  runId: string,
  signal?: AbortSignal,
  deps: WaitDependencies = {},
): Promise<BlockingRunWaitResult> {
  signal?.throwIfAborted();
  const timeoutMs = deps.timeoutMs ?? BUSY_RUN_WAIT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Busy run wait timed out"));
  }, timeoutMs);
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const onInterrupted = () => rejectInterrupted(controller.signal.reason);
  controller.signal.addEventListener("abort", onInterrupted, { once: true });

  try {
    const retrieveRun: NonNullable<WaitDependencies["retrieveRun"]> =
      deps.retrieveRun ??
      ((id, options) => getBackend().retrieveRun(id, options));
    while (true) {
      const run = await Promise.race([
        retrieveRun(runId, {
          signal: controller.signal,
          timeout: Math.max(1, deadline - Date.now()),
          maxRetries: 0,
        }),
        interrupted,
      ]);
      signal?.throwIfAborted();
      if (timedOut || Date.now() >= deadline) return "timed_out";
      if (run.status && TERMINAL_RUN_STATUSES.has(run.status)) return "settled";
      if (!run.status || !ACTIVE_RUN_STATUSES.has(run.status)) {
        return "unavailable";
      }
      await sleepWithAbort(
        Math.min(
          deps.pollIntervalMs ?? BUSY_RUN_POLL_INTERVAL_MS,
          deadline - Date.now(),
        ),
        controller.signal,
      );
    }
  } catch {
    signal?.throwIfAborted();
    return timedOut || Date.now() >= deadline ? "timed_out" : "unavailable";
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    controller.signal.removeEventListener("abort", onInterrupted);
  }
}

export async function waitForBusyRunRetry(
  detail: string,
  fallbackDelayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const runId = extractConversationBusyRunId(detail);
  const result = runId
    ? await waitForBlockingRunToSettle(runId, signal)
    : "unavailable";
  signal?.throwIfAborted();
  if (result === "timed_out") {
    throw new Error(
      `Conversation is still busy because run ${runId} did not settle after ${BUSY_RUN_WAIT_TIMEOUT_MS}ms`,
    );
  }
  if (result !== "settled") await sleepWithAbort(fallbackDelayMs, signal);
}
