import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { getBackend } from "@/backend";
import {
  type ConversationSearchResult,
  searchConversationsForBackend,
} from "@/backend/conversation-search";
import { SYSTEM_REMINDER_CLOSE, SYSTEM_REMINDER_OPEN } from "@/constants";

const BOOTSTRAP_RECENT_LIMIT = 5;
const BOOTSTRAP_RELEVANT_LIMIT = 5;
const BOOTSTRAP_RECENT_FETCH_LIMIT =
  BOOTSTRAP_RECENT_LIMIT + BOOTSTRAP_RELEVANT_LIMIT;
const BOOTSTRAP_RELEVANT_FETCH_LIMIT = 12;
// The remote hybrid search uses RRF with k=60, so a rank-1 result from only
// one retrieval channel scores ~0.016. Require a stronger score so weak
// vector-only nearest neighbors do not get injected as bootstrap context.
const BOOTSTRAP_RELEVANT_MIN_RRF_SCORE = 0.025;
const BOOTSTRAP_RELEVANT_MIN_RELATIVE_SCORE = 0.75;

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

export function extractBootstrapQueryText(
  content: MessageCreate["content"],
): string {
  if (typeof content === "string") {
    return content.trim();
  }

  return content
    .flatMap((item) => {
      if (item.type !== "text") {
        return [];
      }
      const trimmed = item.text.trim();
      return trimmed ? [trimmed] : [];
    })
    .join("\n\n")
    .trim();
}

function formatBootstrapConversationLine(conversation: Conversation): string {
  return `- ${(conversation.summary || "Unlabelled conversation").trim()} [${conversation.id}]`;
}

function formatBootstrapRelevantConversationLine(
  result: ConversationSearchResult,
): string {
  const description = result.embedded_text.trim();
  if (!description) {
    return formatBootstrapConversationLine(result.conversation);
  }

  return `- ${description} [${result.conversation.id}]`;
}

function formatBootstrapReminder(params: {
  recentConversations: Conversation[];
  relevantConversations: ConversationSearchResult[];
}): string {
  const { recentConversations, relevantConversations } = params;
  const lines = [
    SYSTEM_REMINDER_OPEN,
    "This is an automated message providing context from prior conversations with this agent.",
    "The user is starting a brand-new conversation.",
  ];

  if (recentConversations.length > 0) {
    lines.push(
      "",
      "Recent prior conversations:",
      ...recentConversations.map(formatBootstrapConversationLine),
    );
  }

  if (relevantConversations.length > 0) {
    lines.push(
      "",
      "Relevant prior conversation descriptions for the user's first message:",
      ...relevantConversations.map(formatBootstrapRelevantConversationLine),
    );
  }

  lines.push(
    "",
    "Use this as lightweight context only. Do not treat these titles or conversation descriptions as confirmed facts beyond what is written here.",
    "These descriptions are internal search metadata. Do not quote or expose them to the user unless independently supported in the active conversation.",
    SYSTEM_REMINDER_CLOSE,
  );

  return lines.join("\n");
}

export function filterBootstrapRelevantConversations(
  results: ConversationSearchResult[],
  params: {
    excludeConversationId?: string;
  },
): ConversationSearchResult[] {
  const { excludeConversationId } = params;
  const dedupedResults: ConversationSearchResult[] = [];
  const seenConversationIds = new Set<string>();

  for (const result of results) {
    const conversation = result.conversation;
    if (conversation.id === excludeConversationId) {
      continue;
    }

    if (seenConversationIds.has(conversation.id)) {
      continue;
    }

    seenConversationIds.add(conversation.id);
    dedupedResults.push(result);
  }

  if (dedupedResults.length === 0) {
    return [];
  }

  const strongestScore = Math.max(
    ...dedupedResults.map((result) => result.rrf_score),
  );
  const minimumAcceptedScore = Math.max(
    BOOTSTRAP_RELEVANT_MIN_RRF_SCORE,
    strongestScore * BOOTSTRAP_RELEVANT_MIN_RELATIVE_SCORE,
  );

  return dedupedResults
    .filter((result) => result.rrf_score >= minimumAcceptedScore)
    .slice(0, BOOTSTRAP_RELEVANT_LIMIT);
}

export function selectBootstrapRecentConversations(
  conversations: Conversation[],
  params: {
    excludeConversationId?: string;
    relevantConversationIds: Set<string>;
  },
): Conversation[] {
  const { excludeConversationId, relevantConversationIds } = params;
  return conversations
    .filter((conversation) => conversation.id !== excludeConversationId)
    .filter((conversation) => !relevantConversationIds.has(conversation.id))
    .slice(0, BOOTSTRAP_RECENT_LIMIT);
}

export async function buildConversationBootstrapReminder(params: {
  agentId: string;
  content: MessageCreate["content"];
  excludeConversationId?: string;
}): Promise<string | null> {
  const { agentId, content, excludeConversationId } = params;
  const backend = getBackend();
  const queryText = extractBootstrapQueryText(content);

  const [recentResult, relevantResult] = await Promise.allSettled([
    backend.listConversations({
      agent_id: agentId,
      limit: BOOTSTRAP_RECENT_FETCH_LIMIT,
      order: "desc",
      order_by: "last_message_at",
    } as never),
    queryText
      ? searchConversationsForBackend(
          {
            agent_id: agentId,
            query: queryText,
            search_mode: "hybrid",
            search_target: "description",
            limit: BOOTSTRAP_RELEVANT_FETCH_LIMIT,
          },
          backend,
        )
      : Promise.resolve<ConversationSearchResult[]>([]),
  ]);

  const recentConversations =
    recentResult.status === "fulfilled"
      ? pageItems<Conversation>(recentResult.value)
      : [];
  const relevantConversations =
    relevantResult.status === "fulfilled"
      ? filterBootstrapRelevantConversations(relevantResult.value, {
          excludeConversationId,
        })
      : [];
  const relevantConversationIds = new Set(
    relevantConversations.map((result) => result.conversation.id),
  );
  const nonDuplicatedRecentConversations = selectBootstrapRecentConversations(
    recentConversations,
    {
      excludeConversationId,
      relevantConversationIds,
    },
  );

  if (
    nonDuplicatedRecentConversations.length === 0 &&
    relevantConversations.length === 0
  ) {
    return null;
  }

  return formatBootstrapReminder({
    recentConversations: nonDuplicatedRecentConversations,
    relevantConversations,
  });
}
