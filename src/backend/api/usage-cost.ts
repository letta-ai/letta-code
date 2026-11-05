import type { APIClient } from "@/backend/backend";
import { priceUsageEvent } from "@/usage/cost";

/** Resolve request and conversation overrides before the owning agent. */
export async function conversationCostModel(
  client: APIClient,
  conversationId: string,
  agentId?: string | null,
  overrideModel?: string | null,
): Promise<string | null> {
  if (overrideModel) return overrideModel;
  if (conversationId !== "default") {
    const conversation = await client.conversations.retrieve(conversationId);
    if (conversation.model) return conversation.model;
    agentId = conversation.agent_id;
  }
  if (!agentId) return null;
  const agent = await client.agents.retrieve(agentId);
  return agent.model ?? agent.llm_config?.handle ?? null;
}

/** Preserve the stream's controller and metadata; price lazily on the first usage. */
export function withClientUsageCost<T extends { message_type?: string }>(
  stream: AsyncIterable<T>,
  resolveModel: () => Promise<string | null>,
): void {
  // Non-streaming results (and test doubles) have nothing to price.
  if (typeof stream?.[Symbol.asyncIterator] !== "function") return;
  const iterate = stream[Symbol.asyncIterator].bind(stream);
  let model: Promise<string | null> | undefined;
  stream[Symbol.asyncIterator] = async function* () {
    for await (const event of { [Symbol.asyncIterator]: iterate }) {
      if (event.message_type !== "usage_statistics") {
        yield event;
        continue;
      }
      // A failed model lookup must never restore a server-reported estimate.
      model ??= resolveModel().catch(() => null);
      yield priceUsageEvent(event, await model);
    }
  };
}
