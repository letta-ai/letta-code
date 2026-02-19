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
  captureToolExecutionContext,
  waitForToolsetReady,
} from "../tools/manager";
import { isTimingsEnabled } from "../utils/timing";
import { getClient } from "./client";

const streamRequestStartTimes = new WeakMap<object, number>();
const streamToolContextIds = new WeakMap<object, string>();

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

/**
 * Send a message to a conversation and return a streaming response.
 * Uses the conversations API for proper message isolation per session.
 *
 * For the "default" conversation (agent's primary message history without
 * an explicit conversation object), pass conversationId="default" and
 * provide agentId in opts. This uses the agents messages API instead.
 */
export async function sendMessageStream(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: {
    streamTokens?: boolean;
    background?: boolean;
    agentId?: string; // Required when conversationId is "default"
  } = { streamTokens: true, background: true },
  // Disable SDK retries by default - state management happens outside the stream,
  // so retries would violate idempotency and create race conditions
  requestOptions: { maxRetries?: number } = { maxRetries: 0 },
): Promise<Stream<LettaStreamingResponse>> {
  const requestStartTime = isTimingsEnabled() ? performance.now() : undefined;
  const client = await getClient();

  // Wait for any in-progress toolset switch to complete before reading tools
  // This prevents sending messages with stale tools during a switch
  await waitForToolsetReady();
  const { clientTools, contextId } = captureToolExecutionContext();

  let stream: Stream<LettaStreamingResponse>;

  if (process.env.DEBUG) {
    console.log(
      `[DEBUG] sendMessageStream: conversationId=${conversationId}, useAgentsRoute=${conversationId === "default"}`,
    );
  }

  if (conversationId === "default") {
    // Use agents route for default conversation (agent's primary message history)
    if (!opts.agentId) {
      throw new Error(
        "agentId is required in opts when using default conversation",
      );
    }
    stream = await client.agents.messages.create(
      opts.agentId,
      {
        messages: messages,
        streaming: true,
        stream_tokens: opts.streamTokens ?? true,
        background: opts.background ?? true,
        client_tools: clientTools,
        include_compaction_messages: true,
      },
      requestOptions,
    );
  } else {
    // Use conversations route for explicit conversations
    stream = await client.conversations.messages.create(
      conversationId,
      {
        messages: messages,
        streaming: true,
        stream_tokens: opts.streamTokens ?? true,
        background: opts.background ?? true,
        client_tools: clientTools,
        include_compaction_messages: true,
      },
      requestOptions,
    );
  }

  if (requestStartTime !== undefined) {
    streamRequestStartTimes.set(stream as object, requestStartTime);
  }
  streamToolContextIds.set(stream as object, contextId);

  return stream;
}
