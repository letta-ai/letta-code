/**
 * Utilities for sending messages to an agent via conversations
 **/

import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import {
  type ClientTool,
  captureToolExecutionContext,
  waitForToolsetReady,
} from "../tools/manager";
import { isTimingsEnabled } from "../utils/timing";
import {
  type ApprovalNormalizationOptions,
  normalizeOutgoingApprovalMessages,
} from "./approval-result-normalization";
import { getClient } from "./client";

const streamRequestStartTimes = new WeakMap<object, number>();
const streamToolContextIds = new WeakMap<object, string>();
export type StreamRequestContext = {
  conversationId: string;
  resolvedConversationId: string;
  agentId: string | null;
  requestStartedAtMs: number;
};
const streamRequestContexts = new WeakMap<object, StreamRequestContext>();

export function getStreamRequestStartTime(
  stream: Stream<LettaStreamingResponse>,
): number | undefined {
  return streamRequestStartTimes.get(stream as object);
}

export function getStreamToolContextId(
  stream: Stream<LettaStreamingResponse>,
): string | null {
  return streamToolContextIds.get(stream as object) ?? null;
}

export function getStreamRequestContext(
  stream: Stream<LettaStreamingResponse>,
): StreamRequestContext | undefined {
  return streamRequestContexts.get(stream as object);
}

export type SendMessageStreamOptions = {
  streamTokens?: boolean;
  background?: boolean;
  agentId?: string; // Required when conversationId is "default"
  approvalNormalization?: ApprovalNormalizationOptions;
};

export function buildConversationMessagesCreateRequestBody(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  clientTools: ClientTool[],
) {
  const isDefaultConversation = conversationId === "default";
  if (isDefaultConversation && !opts.agentId) {
    throw new Error(
      "agentId is required in opts when using default conversation",
    );
  }

  return {
    messages: normalizeOutgoingApprovalMessages(
      messages,
      opts.approvalNormalization,
    ),
    streaming: true,
    stream_tokens: opts.streamTokens ?? true,
    background: opts.background ?? true,
    client_tools: clientTools,
    include_compaction_messages: true,
    ...(isDefaultConversation ? { agent_id: opts.agentId } : {}),
  };
}

/**
 * Send a message to a conversation and return a streaming response.
 * Uses the conversations API for all conversations.
 *
 * For the "default" conversation (agent's primary message history without
 * an explicit conversation object), pass conversationId="default" and
 * provide agentId in opts. The agent id is sent in the request body.
 */
export async function sendMessageStream(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: SendMessageStreamOptions = { streamTokens: true, background: true },
  // Disable SDK retries by default - state management happens outside the stream,
  // so retries would violate idempotency and create race conditions
  requestOptions: { maxRetries?: number; signal?: AbortSignal } = {
    maxRetries: 0,
  },
): Promise<Stream<LettaStreamingResponse>> {
  const requestStartTime = isTimingsEnabled() ? performance.now() : undefined;
  const requestStartedAtMs = Date.now();
  const client = await getClient();

  // Wait for any in-progress toolset switch to complete before reading tools
  // This prevents sending messages with stale tools during a switch
  await waitForToolsetReady();
  const { clientTools, contextId } = captureToolExecutionContext();

  const resolvedConversationId = conversationId;
  const requestBody = buildConversationMessagesCreateRequestBody(
    conversationId,
    messages,
    opts,
    clientTools,
  );

  if (process.env.DEBUG) {
    console.log(
      `[DEBUG] sendMessageStream: conversationId=${conversationId}, agentId=${opts.agentId ?? "(none)"}`,
    );
  }

  const stream = await client.conversations.messages.create(
    resolvedConversationId,
    requestBody,
    requestOptions,
  );

  if (requestStartTime !== undefined) {
    streamRequestStartTimes.set(stream as object, requestStartTime);
  }
  streamToolContextIds.set(stream as object, contextId);
  streamRequestContexts.set(stream as object, {
    conversationId,
    resolvedConversationId,
    agentId: opts.agentId ?? null,
    requestStartedAtMs,
  });

  return stream;
}
