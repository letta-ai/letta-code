import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import { type ConversationMessageStreamBody, getBackend } from "@/backend";
import { createStreamAbortRelay } from "@/utils/stream-abort-relay";

export async function resumeBusyRequestStream(
  conversationId: string,
  agentId: string | null | undefined,
  input: Array<MessageCreate | ApprovalCreate>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const otid = input
    .map((item) => (item as Record<string, unknown>).otid)
    .find(
      (value): value is string => typeof value === "string" && value.length > 0,
    );
  // Without an OTID the endpoint can fall back to somebody else's active run.
  if (!otid) throw new Error("Cannot resume a busy request without its OTID");
  const relay = createStreamAbortRelay(signal);
  try {
    const stream = await getBackend().streamConversationMessages(
      conversationId,
      {
        agent_id:
          conversationId === "default" ? (agentId ?? undefined) : undefined,
        otid,
        starting_after: 0,
        batch_size: 1000,
      } as unknown as ConversationMessageStreamBody,
      relay ? { signal: relay.signal } : undefined,
    );
    relay?.attach(stream as object);
    if (signal?.aborted) {
      stream.controller.abort();
      signal.throwIfAborted();
    }
    return stream;
  } catch (error) {
    relay?.cleanup();
    throw error;
  }
}
