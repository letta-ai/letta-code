import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { MessageSearchResponse } from "@letta-ai/letta-client/resources/messages";
import { searchMessages, warmSearchCache } from "./api/search";
import { type Backend, getBackend } from "./backend";

type SearchMode = "vector" | "fts" | "hybrid";

type MessageSearchBody = {
  query?: unknown;
  search_mode?: unknown;
  limit?: unknown;
  agent_id?: unknown;
  conversation_id?: unknown;
  start_date?: unknown;
  end_date?: unknown;
};

type LocalSearchMessage = {
  id?: string;
  date?: string;
  message_type?: string;
  content?: unknown;
  reasoning?: string;
  summary?: string;
  tool_call?: { name?: string; arguments?: string };
  tool_calls?: Array<{ name?: string; arguments?: string }>;
  tool_return?: unknown;
  func_response?: unknown;
  agent_id?: string;
  conversation_id?: string;
};

const LOCAL_SEARCH_SCAN_LIMIT = 1000;

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

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (
        part &&
        typeof part === "object" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stringifySearchValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function searchableText(message: LocalSearchMessage): string {
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls
    : message.tool_call
      ? [message.tool_call]
      : [];
  return [
    message.message_type,
    textFromContent(message.content),
    message.reasoning,
    message.summary,
    ...toolCalls.flatMap((call) => [call.name, call.arguments]),
    stringifySearchValue(message.tool_return),
    stringifySearchValue(message.func_response),
  ]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join("\n");
}

function matchesQuery(message: LocalSearchMessage, query: string): boolean {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  if (terms.length === 0) return false;
  const haystack = searchableText(message).toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function withinDateRange(
  message: LocalSearchMessage,
  startDate: string | undefined,
  endDate: string | undefined,
): boolean {
  if (!startDate && !endDate) return true;
  if (!message.date) return true;
  const time = new Date(message.date).getTime();
  if (Number.isNaN(time)) return true;
  const startTime = startDate ? new Date(startDate).getTime() : 0;
  const endTime = endDate
    ? new Date(endDate).getTime()
    : Number.POSITIVE_INFINITY;
  return time >= startTime && time <= endTime;
}

function toSearchResult(
  message: LocalSearchMessage,
): MessageSearchResponse[number] {
  const createdAt = message.date ?? new Date(0).toISOString();
  return {
    ...message,
    message_id: message.id ?? `${message.agent_id ?? "local"}:${createdAt}`,
    created_at: createdAt,
    agent_id: message.agent_id ?? null,
    conversation_id: message.conversation_id ?? null,
  } as MessageSearchResponse[number];
}

async function localConversationMessages(
  backend: Backend,
  conversationId: string,
  agentId?: string,
): Promise<LocalSearchMessage[]> {
  try {
    const page = await backend.listConversationMessages(conversationId, {
      limit: LOCAL_SEARCH_SCAN_LIMIT,
      order: "desc",
      ...(agentId ? { agent_id: agentId } : {}),
    } as never);
    return pageItems<LocalSearchMessage>(page);
  } catch {
    return [];
  }
}

async function localAgentMessages(
  backend: Backend,
  agentId: string,
): Promise<LocalSearchMessage[]> {
  const messages = [
    ...(await localConversationMessages(backend, "default", agentId)),
  ];
  try {
    const conversationsPage = await backend.listConversations({
      agent_id: agentId,
      limit: LOCAL_SEARCH_SCAN_LIMIT,
    } as never);
    const conversations = pageItems<{ id?: string }>(conversationsPage);
    for (const conversation of conversations) {
      if (!conversation.id || conversation.id === "default") continue;
      messages.push(
        ...(await localConversationMessages(backend, conversation.id, agentId)),
      );
    }
  } catch {
    // Best-effort local search: default conversation results are still useful.
  }
  return messages;
}

async function localSearchMessages(
  backend: Backend,
  body: MessageSearchBody,
): Promise<MessageSearchResponse> {
  const query = typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return [];
  const limit = typeof body.limit === "number" ? body.limit : 100;
  const agentId = typeof body.agent_id === "string" ? body.agent_id : undefined;
  const conversationId =
    typeof body.conversation_id === "string" ? body.conversation_id : undefined;
  const startDate =
    typeof body.start_date === "string" ? body.start_date : undefined;
  const endDate = typeof body.end_date === "string" ? body.end_date : undefined;

  let messages: LocalSearchMessage[] = [];
  if (conversationId) {
    messages = await localConversationMessages(
      backend,
      conversationId,
      agentId,
    );
  } else if (agentId) {
    messages = await localAgentMessages(backend, agentId);
  } else {
    const agentsPage = await backend.listAgents({
      limit: LOCAL_SEARCH_SCAN_LIMIT,
    } as never);
    const agents = pageItems<AgentState>(agentsPage);
    for (const agent of agents) {
      messages.push(...(await localAgentMessages(backend, agent.id)));
    }
  }

  return messages
    .filter((message) => matchesQuery(message, query))
    .filter((message) => withinDateRange(message, startDate, endDate))
    .sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
    .slice(0, limit)
    .map(toSearchResult);
}

export async function searchMessagesForBackend<T = MessageSearchResponse>(
  body: MessageSearchBody,
  backend: Backend = getBackend(),
): Promise<T> {
  if (backend.capabilities.localModelCatalog) {
    return (await localSearchMessages(backend, body)) as T;
  }

  return searchMessages<T>({
    ...body,
    search_mode:
      body.search_mode === "vector" ||
      body.search_mode === "fts" ||
      body.search_mode === "hybrid"
        ? (body.search_mode as SearchMode)
        : body.search_mode,
  } as Record<string, unknown>);
}

export async function warmMessageSearchCacheForBackend<T>(
  body: Record<string, unknown>,
  backend: Backend = getBackend(),
): Promise<T> {
  if (backend.capabilities.localModelCatalog) {
    return {
      collection: body.collection ?? "messages",
      status: "local-backend-noop",
      warmed: false,
    } as T;
  }
  return warmSearchCache<T>(body);
}
