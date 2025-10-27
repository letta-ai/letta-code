/**
 * Utilities for sending messages to an agent
 **/

import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaMessageUnion,
  LettaResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getClient } from "./client";

// Streaming response is a union of all message types plus control messages
export type LettaStreamingChunk =
  | LettaMessageUnion
  | LettaResponse["stop_reason"]
  | LettaResponse["usage"]
  | { message_type: "ping" };

export async function sendMessageStream(
  agentId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: {
    streamTokens?: boolean;
    background?: boolean;
    // add more later: includePings, request timeouts, etc.
  } = { streamTokens: true, background: true },
): Promise<AsyncIterable<LettaStreamingChunk>> {
  const client = getClient();
  return client.agents.messages.stream(agentId, {
    messages: messages,
    stream_tokens: opts.streamTokens ?? true,
    background: opts.background ?? true,
  }) as Promise<AsyncIterable<LettaStreamingChunk>>;
}
