import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { searchConversations } from "./api/search";
import { type Backend, getBackend } from "./backend";

type SearchMode = "vector" | "fts" | "hybrid";
type SearchTarget = "summary" | "description";

export type ConversationSearchBody = {
  query?: unknown;
  search_mode?: unknown;
  search_target?: unknown;
  limit?: unknown;
  agent_id?: unknown;
};

export type ConversationSearchResult = {
  embedded_text: string;
  conversation: Conversation;
  rrf_score: number;
};

function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) {
      return maybePage.items;
    }
  }
  return [];
}

function countMatchedTerms(summary: string, terms: string[]): number {
  const haystack = summary.toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length;
}

async function localSearchConversations(
  backend: Backend,
  body: ConversationSearchBody,
): Promise<ConversationSearchResult[]> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) {
    return [];
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) {
    return [];
  }

  const limit = typeof body.limit === "number" ? body.limit : 20;
  const agentId = typeof body.agent_id === "string" ? body.agent_id : undefined;
  const conversations = pageItems<Conversation>(
    await backend.listConversations({
      ...(agentId ? { agent_id: agentId } : {}),
      limit,
      order: "desc",
      order_by: "last_message_at",
    } as never),
  );

  return conversations
    .map((conversation) => {
      const summary = conversation.summary?.trim() ?? "";
      if (!summary) {
        return null;
      }
      const matchedTerms = countMatchedTerms(summary, terms);
      if (matchedTerms === 0) {
        return null;
      }
      return {
        embedded_text: summary,
        conversation,
        rrf_score: matchedTerms / terms.length,
      } satisfies ConversationSearchResult;
    })
    .filter((result): result is ConversationSearchResult => result !== null)
    .sort((a, b) => b.rrf_score - a.rrf_score)
    .slice(0, limit);
}

export async function searchConversationsForBackend(
  body: ConversationSearchBody,
  backend: Backend = getBackend(),
): Promise<ConversationSearchResult[]> {
  if (backend.capabilities.localModelCatalog) {
    return localSearchConversations(backend, body);
  }

  return searchConversations<ConversationSearchResult[]>({
    ...body,
    search_mode:
      body.search_mode === "vector" ||
      body.search_mode === "fts" ||
      body.search_mode === "hybrid"
        ? (body.search_mode as SearchMode)
        : body.search_mode,
    search_target:
      body.search_target === "summary" || body.search_target === "description"
        ? (body.search_target as SearchTarget)
        : "description",
  } as Record<string, unknown>);
}
