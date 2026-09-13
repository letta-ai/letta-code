import { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { actingUserRequestOptions } from "@/agent/acting-user";
import { getClient } from "./client";
import { ApiRequestError, apiFetch, apiRequest } from "./request";

export interface EnqueueReceipt {
  status: "queued";
  agent_id: string;
  conversation_id: string;
  client_message_id: string;
  workflow_id: string;
  super_run_id: string;
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
  const accepted = await request<
    Pick<EnqueueReceipt, "client_message_id" | "workflow_id" | "super_run_id">
  >(
    "POST",
    `/v1/conversations/${encodeURIComponent(input.conversationId)}/messages/enqueue`,
    {
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
    },
    { signal, ...actingUserRequestOptions(input.actingUserId) },
  );
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
