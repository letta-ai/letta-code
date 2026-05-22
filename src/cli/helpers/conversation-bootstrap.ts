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
const BOOTSTRAP_RELEVANT_FETCH_LIMIT = 12;
const BOOTSTRAP_RELEVANT_MIN_RRF_SCORE = 0.01;
const BOOTSTRAP_RELEVANT_MIN_RELATIVE_SCORE = 0.5;

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

function formatBootstrapReminder(params: {
  recentConversations: Conversation[];
  relevantConversations: Conversation[];
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
      "Relevant prior conversations for the user's first message:",
      ...relevantConversations.map(formatBootstrapConversationLine),
    );
  }

  lines.push(
    "",
    "Use this as lightweight context only. Do not treat these summaries as confirmed facts beyond what is written here.",
    SYSTEM_REMINDER_CLOSE,
  );

  return lines.join("\n");
}

function filterBootstrapRelevantConversations(
  results: ConversationSearchResult[],
  params: {
    excludeConversationId?: string;
    recentIds: Set<string>;
  },
): Conversation[] {
  const { excludeConversationId, recentIds } = params;
  const dedupedResults: ConversationSearchResult[] = [];
  const seenConversationIds = new Set<string>();

  for (const result of results) {
    const conversation = result.conversation;
    if (conversation.id === excludeConversationId) {
      continue;
    }

    if (
      recentIds.has(conversation.id) ||
      seenConversationIds.has(conversation.id)
    ) {
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
    .slice(0, BOOTSTRAP_RELEVANT_LIMIT)
    .map((result) => result.conversation);
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
      limit: BOOTSTRAP_RECENT_LIMIT,
      order: "desc",
      order_by: "last_message_at",
    } as never),
    queryText
      ? searchConversationsForBackend(
          {
            agent_id: agentId,
            query: queryText,
            search_mode: "hybrid",
            limit: BOOTSTRAP_RELEVANT_FETCH_LIMIT,
          },
          backend,
        )
      : Promise.resolve<ConversationSearchResult[]>([]),
  ]);

  const recentConversations =
    recentResult.status === "fulfilled"
      ? pageItems<Conversation>(recentResult.value).filter(
          (conversation) => conversation.id !== excludeConversationId,
        )
      : [];
  const recentIds = new Set(
    recentConversations.map((conversation) => conversation.id),
  );
  const relevantConversations =
    relevantResult.status === "fulfilled"
      ? filterBootstrapRelevantConversations(relevantResult.value, {
          excludeConversationId,
          recentIds,
        })
      : [];

  if (recentConversations.length === 0 && relevantConversations.length === 0) {
    return null;
  }

  return formatBootstrapReminder({
    recentConversations,
    relevantConversations,
  });
}
