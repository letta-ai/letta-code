import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { actingUserRequestOptions } from "@/agent/acting-user";
import { getClient } from "./client";
import { ApiRequestError, apiFetch, apiRequest } from "./request";

const SHUTDOWN_MAX_RETRIES = 3;
const SHUTDOWN_DEFAULT_DELAY_MS = 1000;

/** Only the server's explicit pre-admission rejection proves a POST was not accepted. */
export function isProvenCloudApiShutdownRejection(
  error: unknown,
): error is ApiRequestError {
  if (!(error instanceof ApiRequestError) || error.status !== 503) return false;
  try {
    const body: unknown = JSON.parse(error.responseText);
    if (typeof body !== "object" || body === null) return false;
    const payload = body as Record<string, unknown>;
    return (
      payload.errorCode === "cloud_api_shutting_down" &&
      payload.admitted === false &&
      payload.retryable === true
    );
  } catch {
    return false;
  }
}

function shutdownRetryDelayMs(error: ApiRequestError): number {
  const retryAfter = error.headers?.get("Retry-After");
  const seconds =
    retryAfter === null || retryAfter === undefined ? NaN : Number(retryAfter);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(seconds * 1000, 30_000)
    : SHUTDOWN_DEFAULT_DELAY_MS;
}

async function waitForShutdownRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export interface EnqueueReceipt {
  status: "queued";
  agent_id: string;
  conversation_id: string;
  client_message_id: string;
  workflow_id: string;
  super_run_id: string;
  /** Listener selected for a managed Agent launch, used only for cancellation. */
  connection_id?: string;
}

export interface EnqueueConversationInput {
  agentId: string;
  conversationId: string;
  clientMessageId: string;
  content: MessageCreate["content"];
  computer?: string;
  actingUserId?: string;
}

/** Cloud owns delivery after this request returns 202. Never retry by executing locally. */
export async function enqueueConversationMessage(
  input: EnqueueConversationInput,
  signal?: AbortSignal,
  request = apiRequest,
): Promise<EnqueueReceipt> {
  const body = {
    agent_id: input.agentId,
    client_message_id: input.clientMessageId,
    ...(input.computer !== undefined ? { computer: input.computer } : {}),
    messages: [
      {
        role: "user",
        content: input.content,
        client_message_id: input.clientMessageId,
      },
    ],
  };
  let accepted: Pick<
    EnqueueReceipt,
    "client_message_id" | "workflow_id" | "super_run_id"
  >;
  let retries = 0;
  while (true) {
    try {
      accepted = await request(
        "POST",
        `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages/enqueue`,
        body,
        { signal, ...actingUserRequestOptions(input.actingUserId) },
      );
      break;
    } catch (error) {
      if (
        !isProvenCloudApiShutdownRejection(error) ||
        retries >= SHUTDOWN_MAX_RETRIES
      ) {
        throw error;
      }
      retries++;
      await waitForShutdownRetry(shutdownRetryDelayMs(error), signal);
    }
  }
  if (
    accepted.client_message_id !== input.clientMessageId ||
    !accepted.workflow_id ||
    !accepted.super_run_id
  ) {
    throw new Error(
      "Enqueue returned an invalid receipt; acceptance is unknown. Do not resend automatically.",
    );
  }
  return {
    ...accepted,
    status: "queued",
    agent_id: input.agentId,
    conversation_id: input.conversationId,
  };
}

/** Remove this input from either the Cloud delivery queue or listener queue. */
export async function dequeueConversationMessage(
  input: Pick<
    EnqueueConversationInput,
    "agentId" | "conversationId" | "clientMessageId"
  >,
  signal?: AbortSignal,
  request = apiRequest,
): Promise<{
  client_message_id: string;
  status: "dequeued" | "already_dequeued" | "too_late" | "not_found";
}> {
  return request(
    "DELETE",
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages/enqueue/${encodeURIComponent(input.clientMessageId)}`,
    undefined,
    {
      signal,
      ...(input.conversationId === "default"
        ? { query: { agent_id: input.agentId } }
        : {}),
    },
  );
}

/** Relevant fields from the existing Cloud conversation Super Run feed. */
export interface ConversationSendStatus {
  conversation_id: string;
  active_super_runs: Array<{ id: string; status: string }>;
  runtime_status: {
    state: string;
    loop_state: {
      status: string;
      client_message_ids_by_run_id?: Record<string, string[]>;
    } | null;
  } | null;
}

export type ConversationStatusEvent =
  | {
      type: "conversation_super_run_snapshot";
      statuses: ConversationSendStatus[];
    }
  | {
      type: "conversation_super_run_update";
      conversation_id: string;
      status: ConversationSendStatus | null;
    };

export async function openConversationStatusStream(
  agentId: string,
  controller: AbortController,
): Promise<AsyncIterable<ConversationStatusEvent>> {
  const response = await apiFetch(
    `/v1/agents/${encodeURIComponent(agentId)}/super-runs/stream`,
    { signal: controller.signal, headers: { Accept: "text/event-stream" } },
  );
  if (!response.ok) {
    throw new ApiRequestError(
      "Could not subscribe to conversation status",
      response.status,
      await response.text(),
    );
  }
  return Stream.fromSSEResponse<ConversationStatusEvent>(response, controller);
}

export async function listEnqueuedRunMessages(
  runId: string,
  signal?: AbortSignal,
): Promise<Message[]> {
  const client = await getClient();
  const result: Message[] = [];
  for await (const message of client.runs.messages.list(
    runId,
    { limit: 100 },
    { signal },
  )) {
    result.push(message);
  }
  return result;
}

export interface LatestConversationSuperRun {
  id: string;
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  errored_at: string | null;
}

export interface ExactSuperRun extends LatestConversationSuperRun {
  error: {
    code: string;
    message: string;
  } | null;
  /** Associated child runs, newest first. */
  run_ids: string[];
}

/** Read the accepted Super Run and its server-owned result correlation. */
export async function getExactSuperRun(
  agentId: string,
  superRunId: string,
  signal?: AbortSignal,
  request = apiRequest,
): Promise<ExactSuperRun> {
  return request(
    "GET",
    `/v1/agents/${encodeURIComponent(agentId)}/super-runs/${encodeURIComponent(superRunId)}`,
    undefined,
    { signal },
  );
}

export async function getLatestConversationSuperRun(
  conversationId: string,
  signal?: AbortSignal,
): Promise<LatestConversationSuperRun> {
  return apiRequest(
    "GET",
    `/v1/conversations/${encodeURIComponent(conversationId)}/super-run`,
    undefined,
    { signal },
  );
}
