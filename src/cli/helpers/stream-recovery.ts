import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import type { StopReasonType } from "@letta-ai/letta-client/resources/runs/runs";
import type { StreamRequestContext } from "@/agent/message";
import { getClient } from "@/backend/api/client";
import { createRelayedAbortController } from "@/utils/create-relayed-abort-controller";

export type StreamRecoveryPolicy = {
  deadlineMs: number;
  initialDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
};

export type StreamRecoveryFailure = {
  attempts: number;
  finalRunStatus: NonNullable<Run["status"]> | null;
  finalStopReason: StopReasonType | null;
  lastSeqId: number | null;
  runId: string | null;
  underlyingError: string;
};

type RunsListResponse =
  | Run[]
  | {
      getPaginatedItems?: () => Run[];
    };

type RunsListClient = {
  runs: {
    list: (query: {
      agent_id?: string | null;
      conversation_id?: string | null;
      limit?: number | null;
      order?: string | null;
      statuses?: string[] | null;
    }) => Promise<RunsListResponse>;
  };
};

const FALLBACK_RUN_DISCOVERY_TIMEOUT_MS = 5000;

function hasPaginatedItems(
  response: RunsListResponse,
): response is { getPaginatedItems: () => Run[] } {
  return (
    !Array.isArray(response) && typeof response.getPaginatedItems === "function"
  );
}

function parseRunCreatedAtMs(run: Run): number {
  if (!run.created_at) return 0;
  const parsed = Date.parse(run.created_at);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toRunsArray(listResponse: RunsListResponse): Run[] {
  if (Array.isArray(listResponse)) return listResponse;
  if (hasPaginatedItems(listResponse)) {
    return listResponse.getPaginatedItems() ?? [];
  }
  return [];
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(timeoutMessage)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function discoverFallbackRunIdWithTimeout(
  ctx: StreamRequestContext,
): Promise<string | null> {
  const client = await getClient();
  return withTimeout(
    discoverFallbackRunIdForResume(client, ctx),
    FALLBACK_RUN_DISCOVERY_TIMEOUT_MS,
    `Fallback run discovery timed out after ${FALLBACK_RUN_DISCOVERY_TIMEOUT_MS}ms`,
  );
}

/**
 * Attempt to discover a run ID to resume when the initial stream failed before
 * any run_id-bearing chunk arrived.
 */
export async function discoverFallbackRunIdForResume(
  client: RunsListClient,
  ctx: StreamRequestContext,
): Promise<string | null> {
  const requestStartedAtMs = ctx.requestStartedAtMs;

  const listCandidates = async (query: {
    agent_id?: string | null;
    conversation_id?: string | null;
  }): Promise<Run[]> => {
    const response = await client.runs.list({
      ...query,
      statuses: ["running"],
      order: "desc",
      limit: 1,
    });
    return toRunsArray(response).filter((run) => {
      if (!run.id || run.status !== "running") return false;
      // Best-effort temporal filter: only consider runs created after this send
      // request started. OTID-based recovery is preferred when available.
      return parseRunCreatedAtMs(run) >= requestStartedAtMs;
    });
  };

  const lookupQueries: Array<{
    agent_id?: string | null;
    conversation_id?: string | null;
  }> = [];

  if (ctx.conversationId === "default") {
    lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
  } else {
    lookupQueries.push({ conversation_id: ctx.conversationId });
    if (ctx.resolvedConversationId !== ctx.conversationId) {
      lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
    }
  }

  if (ctx.agentId) lookupQueries.push({ agent_id: ctx.agentId });

  for (const query of lookupQueries) {
    const candidates = await listCandidates(query);
    if (candidates[0]?.id) return candidates[0].id;
  }

  return null;
}

export function isActiveRunWithoutError(run: Run): boolean {
  return (
    (run.status === "created" || run.status === "running") &&
    !run.metadata?.error
  );
}

export function shouldReplayRunForRecovery(run: Run): boolean {
  if (isActiveRunWithoutError(run)) return true;
  return (
    run.status === "completed" &&
    run.stop_reason !== "error" &&
    run.stop_reason !== "llm_api_error" &&
    !run.metadata?.error
  );
}

export function nextStreamRecoveryDelayMs(
  policy: StreamRecoveryPolicy,
  completedAttempts: number,
): number {
  return Math.min(
    policy.initialDelayMs * 2 ** Math.max(0, completedAttempts - 1),
    policy.maxDelayMs,
  );
}

export async function waitForStreamRecoveryDelay(
  delayMs: number,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  if (abortSignal?.aborted) return false;
  if (delayMs <= 0) return true;

  return await new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      resolve(false);
    };

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve(true);
    }, delayMs);
  });
}

export function createStreamRecoveryAttemptAbort(
  parentSignal: AbortSignal,
  timeoutMs: number,
): { cleanup: () => void; signal: AbortSignal } {
  const relay = createRelayedAbortController(parentSignal);
  const timer = setTimeout(
    () => relay.controller.abort(new Error("Stream recovery deadline expired")),
    Math.max(0, timeoutMs),
  );
  return {
    signal: relay.signal,
    cleanup: () => {
      clearTimeout(timer);
      relay.cleanup();
    },
  };
}

export async function withStreamRecoveryTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<T> {
  if (abortSignal?.aborted) throw new Error("Stream recovery aborted");

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      abortSignal?.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const onAbort = () => rejectOnce(new Error("Stream recovery aborted"));

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(
      () => rejectOnce(new Error("Stream recovery deadline expired")),
      Math.max(0, timeoutMs),
    );
    Promise.resolve().then(operation).then(resolveOnce, rejectOnce);
  });
}
