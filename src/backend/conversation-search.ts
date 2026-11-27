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

// The local backend has no server-side relevance ranking, so the candidate set
// has to be fetched before the ranking runs. Applying the result limit to the
// fetch limited the search to the newest N conversations, so an older
// conversation whose summary matched the query was never examined at all.
const LOCAL_SEARCH_FETCH_PAGE_SIZE = 500;

async function listLocalSearchCandidates(
  backend: Backend,
  agentId: string | undefined,
): Promise<Conversation[]> {
  const candidates: Conversation[] = [];
  const seenConversationIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  while (true) {
    const page = pageItems<Conversation>(
      await backend.listConversations({
        ...(agentId ? { agent_id: agentId } : {}),
        limit: LOCAL_SEARCH_FETCH_PAGE_SIZE,
        order: "desc",
        order_by: "last_message_at",
        ...(cursor ? { after: cursor } : {}),
      } as never),
    );

    for (const conversation of page) {
      if (seenConversationIds.has(conversation.id)) continue;
      seenConversationIds.add(conversation.id);
      candidates.push(conversation);
    }

    if (page.length < LOCAL_SEARCH_FETCH_PAGE_SIZE) {
      break;
    }

    // Guard against a backend that ignores the cursor and keeps returning the
    // same page: without this the loop would never terminate.
    const nextCursor = page.at(-1)?.id;
    if (!nextCursor || seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  return candidates;
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
  const conversations = await listLocalSearchCandidates(backend, agentId);

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
