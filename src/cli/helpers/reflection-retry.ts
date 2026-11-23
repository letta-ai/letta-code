import type { ReflectionMemoryWorktreeFinalizeResult } from "@/agent/memory-worktree";

const INITIAL_RETRY_DELAY_MS = 60_000;
const MAX_RETRY_DELAY_MS = 30 * 60_000;

const retries = new Map<
  string,
  { delayMs: number; retryAt: number; notifiedFailures: Set<string> }
>();

export function isReflectionRetryDeferred(
  agentId: string,
  triggerSource: string,
  now = Date.now(),
): boolean {
  return (
    triggerSource !== "manual" && now < (retries.get(agentId)?.retryAt ?? 0)
  );
}

export function recordReflectionIntegrationRetry(
  agentId: string,
  integration: ReflectionMemoryWorktreeFinalizeResult,
  success: boolean,
  triggerSource: string,
  now = Date.now(),
): boolean {
  if (success) {
    retries.delete(agentId);
    return true;
  }
  if (
    integration.status === "failed" &&
    integration.failurePhase !== "integration"
  ) {
    return true;
  }

  const previous = retries.get(agentId);
  const delayMs = previous
    ? Math.min(previous.delayMs * 2, MAX_RETRY_DELAY_MS)
    : INITIAL_RETRY_DELAY_MS;
  const notifiedFailures = previous?.notifiedFailures ?? new Set<string>();
  const failure = `${integration.status}:${integration.failurePhase ?? ""}`;
  const shouldNotify =
    triggerSource === "manual" || !notifiedFailures.has(failure);
  notifiedFailures.add(failure);
  retries.set(agentId, { delayMs, retryAt: now + delayMs, notifiedFailures });
  return shouldNotify;
}
