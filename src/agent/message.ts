/**
 * Utilities for sending messages to an agent via conversations
 **/

import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getClientToolsFromRegistry } from "../tools/manager";
import { isTimingsEnabled } from "../utils/timing";
import { getClient } from "./client";

// Symbol to store timing info on the stream object
export const STREAM_REQUEST_START_TIME = Symbol("streamRequestStartTime");

/**
 * Send a message to a conversation and return a streaming response.
 * Uses the conversations API for proper message isolation per session.
 */
export async function sendMessageStream(
  conversationId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: {
    streamTokens?: boolean;
    background?: boolean;
    // add more later: includePings, request timeouts, etc.
  } = { streamTokens: true, background: true },
  // TODO: Re-enable once issues are resolved - disabled retries were causing problems
  // Disable SDK retries by default - state management happens outside the stream,
  // so retries would violate idempotency and create race conditions
  // requestOptions: { maxRetries?: number } = { maxRetries: 0 },
  requestOptions: { maxRetries?: number } = {},
): Promise<Stream<LettaStreamingResponse>> {
  // Capture request start time for TTFT measurement when timings are enabled
  const requestStartTime = isTimingsEnabled() ? performance.now() : undefined;

  const client = await getClient();
  const stream = await client.conversations.messages.create(
    conversationId,
    {
      messages: messages,
      streaming: true,
      stream_tokens: opts.streamTokens ?? true,
      background: opts.background ?? true,
      client_tools: getClientToolsFromRegistry(),
    },
    requestOptions,
  );

  // Attach start time to stream for TTFT calculation in drainStream
  if (requestStartTime !== undefined) {
    (stream as unknown as Record<symbol, number>)[STREAM_REQUEST_START_TIME] =
      requestStartTime;
  }

  return stream;
}
