import type { Run } from "@letta-ai/letta-client/resources/agents/messages";
import type { StreamRequestContext } from "@/agent/message";
import { getClient } from "@/backend/api/client";
import type { ApprovalRequest } from "@/cli/helpers/stream-processor";

export type StreamResumePolicy = {
  initialDelayMs: number;
  maxAttempts: number;
  maxDelayMs: number;
};

type RunsListResponse =
  | Run[]
  | {
      getPaginatedItems?: () => Run[];
    };

export type RunsListClient = {
  runs: {
    list: (query: {
      conversation_id?: string | null;
      agent_id?: string | null;
      statuses?: string[] | null;
      order?: string | null;
      limit?: number | null;
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
  const statuses = ["running"];
  const requestStartedAtMs = ctx.requestStartedAtMs;

  const listCandidates = async (query: {
    conversation_id?: string | null;
    agent_id?: string | null;
  }): Promise<Run[]> => {
    const response = await client.runs.list({
      ...query,
      statuses,
      order: "desc",
      limit: 1,
    });
    return toRunsArray(response).filter((run) => {
      if (!run.id) return false;
      if (run.status !== "running") return false;
      // Best-effort temporal filter: only consider runs created after
      // this send request started. In rare concurrent-send races within
      // the same conversation, this heuristic can still pick a neighbor run.
      return parseRunCreatedAtMs(run) >= requestStartedAtMs;
    });
  };

  const lookupQueries: Array<{
    conversation_id?: string | null;
    agent_id?: string | null;
  }> = [];

  if (ctx.conversationId === "default") {
    // Default conversation lookup by conversation id first.
    lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
  } else {
    // Named conversation: first use the explicit conversation id.
    lookupQueries.push({ conversation_id: ctx.conversationId });

    // Keep resolved route as backup only when it differs.
    if (ctx.resolvedConversationId !== ctx.conversationId) {
      lookupQueries.push({ conversation_id: ctx.resolvedConversationId });
    }
  }

  if (ctx.agentId) {
    lookupQueries.push({ agent_id: ctx.agentId });
  }

  for (const query of lookupQueries) {
    const candidates = await listCandidates(query);
    if (candidates[0]?.id) return candidates[0].id;
  }

  return null;
}

export function isReplayableRun(run: Run): boolean {
  if (run.metadata?.error) return false;
  if (run.status === "created" || run.status === "running") return true;
  return (
    run.status === "completed" &&
    run.stop_reason !== "error" &&
    run.stop_reason !== "llm_api_error"
  );
}

export async function waitForResumeRetry(
  delayMs: number,
  abortSignal: AbortSignal,
): Promise<boolean> {
  if (abortSignal.aborted) return false;
  return await new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      abortSignal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    abortSignal.addEventListener("abort", onAbort, { once: true });
  });
}

export function mergeApprovalRequests(
  previous: ApprovalRequest[] | undefined,
  next: ApprovalRequest[] | undefined,
): ApprovalRequest[] {
  const merged = previous?.map((approval) => ({ ...approval })) ?? [];
  for (const approval of next ?? []) {
    const existing = merged.find(
      (candidate) => candidate.toolCallId === approval.toolCallId,
    );
    if (existing) {
      existing.toolName ||= approval.toolName;
      existing.toolArgs += approval.toolArgs;
    } else {
      merged.push({ ...approval });
    }
  }
  return merged;
}
