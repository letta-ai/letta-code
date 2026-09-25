import { getParentConversationScopes } from "@/agent/subagents/parent-conversation";
import { debugLog } from "@/utils/debug";

export interface ParentConversationBackend {
  retrieveConversation(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  retrieveAgent(id: string): Promise<unknown>;
}

/** Yield named parents as they are found, without delaying already-known writes. */
export async function* getPullRequestParentConversationIds(
  backend: ParentConversationBackend,
  scope: { agentId?: string | null; conversationId?: string | null },
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const queue = [scope];
  const visited = new Set<string>();
  // Same bound as task-scoped launcher IDs; cycles cannot keep a shell open.
  while (queue.length && visited.size < 20) {
    signal?.throwIfAborted();
    const current = queue.shift();
    if (!current?.conversationId) continue;
    const key = `${current.agentId ?? ""}/${current.conversationId}`;
    if (visited.has(key)) continue;
    visited.add(key);
    try {
      const record =
        current.conversationId === "default"
          ? current.agentId
            ? await backend.retrieveAgent(current.agentId)
            : undefined
          : await backend.retrieveConversation(current.conversationId, {
              signal,
            });
      signal?.throwIfAborted();
      const tags =
        typeof record === "object" && record !== null
          ? Reflect.get(record, "tags")
          : undefined;
      const parents = getParentConversationScopes(
        Array.isArray(tags)
          ? tags.filter((tag): tag is string => typeof tag === "string")
          : [],
      );
      for (const parent of parents) {
        if (parent.conversationId !== "default") yield parent.conversationId;
        if (!visited.has(`${parent.agentId}/${parent.conversationId}`))
          queue.push(parent);
      }
    } catch (error) {
      if (signal?.aborted) signal.throwIfAborted();
      debugLog(
        "github-pr-tracking",
        `Failed to read parent conversations for ${key}`,
        error,
      );
    }
  }
}
