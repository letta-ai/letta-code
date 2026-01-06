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
import { getClient } from "./client";

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
): Promise<Stream<LettaStreamingResponse>> {
  const client = await getClient();
  return client.conversations.messages.create(conversationId, {
    messages: messages,
    streaming: true,
    stream_tokens: opts.streamTokens ?? true,
    background: opts.background ?? true,
    client_tools: getClientToolsFromRegistry(),
  });
}
