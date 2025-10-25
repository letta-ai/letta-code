/**
 * Utilities for sending messages to an agent
 **/

import type { Letta } from "@letta-ai/letta-client";
import { getClient } from "./client";

export async function sendMessageStream(
  agentId: string,
  messages: Array<Letta.MessageCreate | Letta.ApprovalCreate>,
  opts: {
    streamTokens?: boolean;
    background?: boolean;
    // add more later: includePings, request timeouts, etc.
  } = { streamTokens: true, background: true },
): Promise<AsyncIterable<Letta.LettaStreamingResponse>> {
  const client = getClient();
  return client.agents.messages.createStream(agentId, {
    messages: messages,
    streamTokens: opts.streamTokens ?? true,
    background: opts.background ?? true,
  });
}
