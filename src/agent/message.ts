/**
 * Utilities for sending messages to an agent
 **/

import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ApprovalCreate,
  LettaStreamingResponse,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getClient } from "./client";

export async function sendMessageStream(
  agentId: string,
  messages: Array<MessageCreate | ApprovalCreate>,
  opts: {
    streamTokens?: boolean;
    background?: boolean;
    // add more later: includePings, request timeouts, etc.
  } = { streamTokens: true, background: true },
): Promise<Stream<LettaStreamingResponse>> {
  const client = await getClient();
  return client.agents.messages.create(agentId, {
    messages: messages,
    streaming: true,
    stream_tokens: opts.streamTokens ?? true,
    background: opts.background ?? true,
  });
}
