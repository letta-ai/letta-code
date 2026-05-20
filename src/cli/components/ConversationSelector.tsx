import type {
  Message,
  MessageType,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box, type Key, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Backend, getBackend } from "@/backend";
import { CLI_GLYPHS } from "@/cli/helpers/glyphs";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "@/constants";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import type { SelectableItem } from "./SingleSelectPicker";
import { SingleSelectPicker } from "./SingleSelectPicker";
import { Text } from "./Text";

interface ConversationSelectorProps {
  agentId: string;
  agentName?: string;
  currentConversationId: string;
  onSelect: (
    conversationId: string,
    context?: {
      summary?: string;
      messageCount: number;
    },
  ) => void;
  onNewConversation: () => void;
  onCancel: () => void;
}

// Preview line with role prefix
interface PreviewLine {
  role: "user" | "assistant";
  text: string;
}

// Enriched conversation with message data
interface EnrichedConversation {
  conversation: Conversation;
  previewLines: PreviewLine[] | null; // null = not yet loaded
  lastActiveAt: string | null; // Falls back to updated_at until enriched
  messageCount: number; // -1 = unknown/loading
  enriched: boolean; // Whether message data has been fetched
}

const DISPLAY_PAGE_SIZE = 3;
const FETCH_PAGE_SIZE = 20;
const ENRICH_MESSAGE_LIMIT = 20; // Same as original fetch limit

const RESUME_PREVIEW_MESSAGE_TYPES: MessageType[] = [
  "user_message",
  "assistant_message",
];

function paginatedItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
}

/**
 * Format a relative time string from a date
 */
function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60)
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return `${diffWeeks} week${diffWeeks === 1 ? "" : "s"} ago`;
}

/**
 * Extract preview text from a user message
 * Content can be a string or an array of content parts like [{ type: "text", text: "..." }]
 */
function extractUserMessagePreview(message: Message): string | null {
  // User messages have a 'content' field
  const content = (
    message as Message & {
      content?: string | Array<{ type?: string; text?: string }>;
    }
  ).content;

  if (!content) return null;

  let textToShow: string | null = null;

  if (typeof content === "string") {
    textToShow = content;
  } else if (Array.isArray(content)) {
    // Find the last text part that isn't a system-reminder
    // (system-reminders are auto-injected context, not user text)
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part?.type === "text" && part.text) {
        // Skip system-reminder blocks
        if (
          part.text.startsWith(SYSTEM_REMINDER_OPEN) ||
          part.text.startsWith(SYSTEM_ALERT_OPEN)
        ) {
          continue;
        }
        textToShow = part.text;
        break;
      }
    }
  }

  if (!textToShow) return null;

  // Strip newlines and collapse whitespace
  textToShow = textToShow.replace(/\s+/g, " ").trim();

  // Truncate to a reasonable preview length
  const maxLen = 60;
  if (textToShow.length > maxLen) {
    return `${textToShow.slice(0, maxLen - 3)}...`;
  }
  return textToShow;
}

/**
 * Extract preview text from an assistant message
 * Content can be a string or array of content parts (text, images, etc.)
 */
function extractAssistantMessagePreview(message: Message): string | null {
  // Assistant messages have content field directly on message
  const content = (
    message as Message & {
      content?: string | Array<{ type?: string; text?: string }>;
    }
  ).content;

  if (!content) return null;

  let textToShow: string | null = null;

  if (typeof content === "string") {
    textToShow = content.trim();
  } else if (Array.isArray(content)) {
    // Find the first text part
    for (const part of content) {
      if (part?.type === "text" && part.text) {
        textToShow = part.text.trim();
        break;
      }
    }
  }

  if (!textToShow) return null;

  // Strip newlines and collapse whitespace
  textToShow = textToShow.replace(/\s+/g, " ").trim();

  // Truncate to a reasonable preview length
  const maxLen = 60;
  if (textToShow.length > maxLen) {
    return `${textToShow.slice(0, maxLen - 3)}...`;
  }
  return textToShow;
}

/**
 * Get preview lines and stats from messages
 */
function getMessageStats(messages: Message[]): {
  previewLines: PreviewLine[];
  lastActiveAt: string | null;
  messageCount: number;
} {
  if (messages.length === 0) {
    return { previewLines: [], lastActiveAt: null, messageCount: 0 };
  }

  // Find last 3 user/assistant messages with actual content (searching from end)
  const previewLines: PreviewLine[] = [];
  for (let i = messages.length - 1; i >= 0 && previewLines.length < 3; i--) {
    const msg = messages[i];
    if (!msg) continue;

    if (msg.message_type === "user_message") {
      const text = extractUserMessagePreview(msg);
      if (text) {
        previewLines.unshift({ role: "user", text });
      }
    } else if (msg.message_type === "assistant_message") {
      const text = extractAssistantMessagePreview(msg);
      if (text) {
        previewLines.unshift({ role: "assistant", text });
      }
    }
  }

  // Last activity is the timestamp of the last message
  const lastMessage = messages[messages.length - 1];
  const lastActiveAt =
    (lastMessage as Message & { date?: string }).date ?? null;

  return { previewLines, lastActiveAt, messageCount: messages.length };
}

export function ConversationSelector({
  agentId,
  agentName,
  currentConversationId,
  onSelect,
  onNewConversation,
  onCancel,
}: ConversationSelectorProps) {
  const backendRef = useRef<Backend | null>(null);
  const selectorBackend = useCallback(() => {
    const backend = backendRef.current ?? getBackend();
    backendRef.current = backend;
    return backend;
  }, []);

  // Conversation list state (enriched with message data)
  const [conversations, setConversations] = useState<EnrichedConversation[]>(
    [],
  );
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enriching, setEnriching] = useState(false);

  // Pagination state
  const [page, setPage] = useState(0);

  // Enrich a single conversation with message data, updating state in-place
  const enrichConversation = useCallback(
    async (backend: Backend, convId: string) => {
      try {
        const messages = await backend.listConversationMessages(convId, {
          limit: ENRICH_MESSAGE_LIMIT,
          order: "desc",
          include_return_message_types: RESUME_PREVIEW_MESSAGE_TYPES,
          agent_id: agentId,
        });
        const chronological = [...paginatedItems(messages)].reverse();
        const stats = getMessageStats(chronological);
        setConversations((prev) =>
          prev.map((c) =>
            c.conversation.id === convId
              ? {
                  ...c,
                  previewLines: stats.previewLines,
                  lastActiveAt: stats.lastActiveAt || c.lastActiveAt,
                  messageCount: stats.messageCount,
                  enriched: true,
                }
              : c,
          ),
        );
        return stats.messageCount;
      } catch {
        // Mark as enriched even on error so we don't retry
        setConversations((prev) =>
          prev.map((c) =>
            c.conversation.id === convId
              ? { ...c, previewLines: [], enriched: true }
              : c,
          ),
        );
        return -1;
      }
    },
    [agentId],
  );

  // Load conversations — shows list immediately, enriches progressively
  const loadConversations = useCallback(
    async (afterCursor?: string | null) => {
      const isLoadingMore = !!afterCursor;
      if (isLoadingMore) {
        setLoadingMore(true);
      } else {
        setLoading(true);
      }
      setError(null);

      try {
        const backend = selectorBackend();

        // Phase 1: Fetch conversation list + default messages in parallel
        const conversationListPromise = backend.listConversations({
          agent_id: agentId,
          limit: FETCH_PAGE_SIZE,
          ...(afterCursor && { after: afterCursor }),
          order: "desc",
          order_by: "last_run_completion",
        });

        // Fetch default conversation in parallel (not sequentially before)
        const defaultPromise: Promise<EnrichedConversation | null> =
          !afterCursor
            ? backend
                .listAgentMessages(agentId, {
                  conversation_id: "default",
                  limit: ENRICH_MESSAGE_LIMIT,
                  order: "desc",
                  include_return_message_types: RESUME_PREVIEW_MESSAGE_TYPES,
                })
                .then((msgs) => {
                  const items = paginatedItems(msgs);
                  if (items.length === 0) return null;
                  const stats = getMessageStats([...items].reverse());
                  return {
                    conversation: {
                      id: "default",
                      agent_id: agentId,
                      created_at: new Date().toISOString(),
                    } as Conversation,
                    previewLines: stats.previewLines,
                    lastActiveAt: stats.lastActiveAt,
                    messageCount: stats.messageCount,
                    enriched: true,
                  };
                })
                .catch(() => null)
            : Promise.resolve(null);

        const [result, defaultConversation] = await Promise.all([
          conversationListPromise,
          defaultPromise,
        ]);

        // Build unenriched conversation list using data already on the object
        const unenrichedList: EnrichedConversation[] = result.map((conv) => ({
          conversation: conv,
          previewLines: null, // Not loaded yet
          lastActiveAt: conv.updated_at ?? conv.created_at ?? null,
          messageCount: -1, // Unknown until enriched
          enriched: false,
        }));

        // Don't filter yet — we'll remove empties after enrichment confirms messageCount
        const nonEmptyList = unenrichedList;

        const newCursor =
          result.length === FETCH_PAGE_SIZE
            ? (result[result.length - 1]?.id ?? null)
            : null;

        // Phase 1 render: show conversation list immediately
        if (isLoadingMore) {
          setConversations((prev) => [...prev, ...nonEmptyList]);
        } else {
          const allConversations = defaultConversation
            ? [defaultConversation, ...nonEmptyList]
            : nonEmptyList;
          setConversations(allConversations);
          setPage(0);
        }
        setCursor(newCursor);
        setHasMore(newCursor !== null);

        // Flip loading off now — list is visible, enrichment happens in background
        if (isLoadingMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }

        // Phase 2: enrich visible page first, then rest in background
        setEnriching(true);
        const toEnrich = nonEmptyList.filter((c) => !c.enriched);
        const firstPageItems = toEnrich.slice(0, DISPLAY_PAGE_SIZE);
        const restItems = toEnrich.slice(DISPLAY_PAGE_SIZE);

        // Enrich first page in parallel
        const firstPageResults = await Promise.all(
          firstPageItems.map((c) =>
            enrichConversation(backend, c.conversation.id),
          ),
        );

        // Remove conversations that turned out empty after enrichment
        const emptyConvIds = new Set(
          firstPageItems
            .filter((_, i) => firstPageResults[i] === 0)
            .map((c) => c.conversation.id),
        );
        if (emptyConvIds.size > 0) {
          setConversations((prev) =>
            prev.filter((c) => !emptyConvIds.has(c.conversation.id)),
          );
        }

        // Enrich remaining conversations one by one in background
        for (const item of restItems) {
          const count = await enrichConversation(backend, item.conversation.id);
          if (count === 0) {
            setConversations((prev) =>
              prev.filter((c) => c.conversation.id !== item.conversation.id),
            );
          }
        }

        setEnriching(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [agentId, enrichConversation, selectorBackend],
  );

  // Initial load
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Re-enrich when page changes (prioritize newly visible unenriched items)
  useEffect(() => {
    const backend = backendRef.current;
    if (!backend || loading) return;

    const visibleItems = conversations.slice(
      page * DISPLAY_PAGE_SIZE,
      (page + 1) * DISPLAY_PAGE_SIZE,
    );
    const unenriched = visibleItems.filter((c) => !c.enriched);
    if (unenriched.length === 0) return;

    for (const item of unenriched) {
      enrichConversation(backend, item.conversation.id);
    }
  }, [page, loading, conversations, enrichConversation]);

  // Pagination calculations
  const totalPages = Math.ceil(conversations.length / DISPLAY_PAGE_SIZE);
  const startIndex = page * DISPLAY_PAGE_SIZE;
  const pageConversations = conversations.slice(
    startIndex,
    startIndex + DISPLAY_PAGE_SIZE,
  );
  const canGoNext = page < totalPages - 1 || hasMore;

  // Fetch more when needed
  const fetchMore = useCallback(async () => {
    if (loadingMore || !hasMore || !cursor) return;
    await loadConversations(cursor);
  }, [loadingMore, hasMore, cursor, loadConversations]);

  // Build SelectableItem[] from pageConversations
  const items: SelectableItem[] = pageConversations.map((enrichedConv) => ({
    key: enrichedConv.conversation.id,
    label: "", // Not used — renderItem handles all rendering
    isCurrent: enrichedConv.conversation.id === currentConversationId,
  }));

  // Handle select
  const handleSelect = useCallback(
    (key: string) => {
      const selected = conversations.find((c) => c.conversation.id === key);
      if (selected?.conversation.id) {
        onSelect(selected.conversation.id, {
          summary: selected.conversation.summary ?? undefined,
          messageCount: selected.messageCount,
        });
      }
    },
    [conversations, onSelect],
  );

  // Handle unhandled keys (←→ for pagination, N for new conversation)
  const handleUnhandledKey = useCallback(
    (input: string, key: Key) => {
      if (loading) return;
      if (key.leftArrow && page > 0) {
        setPage((p) => p - 1);
      }
      if (key.rightArrow && canGoNext) {
        const nextPageIndex = page + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= conversations.length && hasMore) {
          fetchMore();
        }

        if (nextStartIndex < conversations.length) {
          setPage(nextPageIndex);
        }
      }
      if (input === "n" || input === "N") {
        onNewConversation();
      }
    },
    [
      loading,
      page,
      canGoNext,
      conversations.length,
      hasMore,
      fetchMore,
      onNewConversation,
    ],
  );

  // Render item callback — full multi-line conversation display
  const renderItem = useCallback(
    (item: SelectableItem, _index: number, isSelected: boolean) => {
      const enrichedConv = pageConversations.find(
        (c) => c.conversation.id === item.key,
      );
      if (!enrichedConv) return null;

      const {
        conversation: conv,
        previewLines,
        lastActiveAt,
        messageCount,
      } = enrichedConv;
      const isCurrent = conv.id === currentConversationId;

      // Format timestamps
      const activeTime = formatRelativeTime(lastActiveAt);
      const createdTime = formatRelativeTime(conv.created_at);

      // Build preview content: (1) summary if exists, (2) preview lines, (3) message count fallback
      // Uses L-bracket indentation style for visual hierarchy
      const renderPreview = () => {
        const bracket = <Text dimColor>{`${CLI_GLYPHS.result}  `}</Text>;
        const indent = "   "; // Same width as "└  " for alignment

        // Still loading message data
        if (previewLines === null) {
          return (
            <Box flexDirection="row" marginLeft={2}>
              {bracket}
              <Text dimColor italic>
                Loading preview...
              </Text>
            </Box>
          );
        }

        // Has preview lines from messages
        if (previewLines.length > 0) {
          return (
            <>
              {previewLines.map((line, idx) => (
                <Box
                  key={`${line.role}-${idx}`}
                  flexDirection="row"
                  marginLeft={2}
                >
                  {idx === 0 ? bracket : <Text>{indent}</Text>}
                  <Text dimColor>
                    {line.role === "assistant" ? "👾 " : "👤 "}
                  </Text>
                  <Text dimColor italic>
                    {line.text}
                  </Text>
                </Box>
              ))}
            </>
          );
        }

        // Priority 3: Message count fallback
        if (messageCount > 0) {
          return (
            <Box flexDirection="row" marginLeft={2}>
              {bracket}
              <Text dimColor italic>
                {messageCount} message{messageCount === 1 ? "" : "s"} (no
                in-context user/agent messages)
              </Text>
            </Box>
          );
        }

        return (
          <Box flexDirection="row" marginLeft={2}>
            {bracket}
            <Text dimColor italic>
              No in-context messages
            </Text>
          </Box>
        );
      };

      const isDefault = conv.id === "default";

      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexDirection="row">
            <Text
              color={isSelected ? colors.selector.itemHighlighted : undefined}
            >
              {isSelected ? ">" : " "}
            </Text>
            <Text> </Text>
            <Text
              bold={isSelected}
              color={isSelected ? colors.selector.itemHighlighted : undefined}
            >
              {conv.summary
                ? `${conv.summary.length > 40 ? `${conv.summary.slice(0, 37)}...` : conv.summary} (${conv.id})`
                : isDefault
                  ? "default"
                  : conv.id}
            </Text>
            {!conv.summary && isDefault && (
              <Text dimColor> (agent's default conversation)</Text>
            )}
            {isCurrent && (
              <Text color={colors.selector.itemCurrent}> (current)</Text>
            )}
          </Box>
          {renderPreview()}
          <Box flexDirection="row" marginLeft={2}>
            <Text dimColor>
              Active {activeTime} · Created {createdTime}
            </Text>
          </Box>
        </Box>
      );
    },
    [pageConversations, currentConversationId],
  );

  const showPicker = !loading && !error && conversations.length > 0;

  // Handle Ctrl-C/Escape/N when picker is not shown (loading, error, empty states)
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }
      if (key.escape) {
        onCancel();
        return;
      }
      if (!loading && !error && (input === "n" || input === "N")) {
        onNewConversation();
      }
    },
    { isActive: !showPicker },
  );

  return (
    <OverlayShell command="/resume" title="Resume a previous conversation">
      {/* Error state */}
      {error && (
        <Box flexDirection="column">
          <Text color="red">Error: {error}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Loading state */}
      {loading && (
        <Box>
          <Text dimColor>Loading conversations...</Text>
        </Box>
      )}

      {/* Enriching indicator */}
      {!loading && enriching && (
        <Box marginBottom={1}>
          <Text dimColor italic>
            Loading previews...
          </Text>
        </Box>
      )}

      {/* Empty state */}
      {!loading && !error && conversations.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            No conversations for {agentName || agentId.slice(0, 12)}
          </Text>
          <Text dimColor>Press N to start a new conversation</Text>
        </Box>
      )}

      {/* Picker */}
      {showPicker && (
        <SingleSelectPicker
          key={page}
          items={items}
          onSelect={handleSelect}
          onCancel={onCancel}
          renderItem={renderItem}
          onUnhandledKey={handleUnhandledKey}
          footer={
            <Box flexDirection="column">
              <Text dimColor>
                {"  "}Page {page + 1}
                {hasMore ? "+" : `/${totalPages || 1}`}
                {loadingMore ? " (loading...)" : ""}
              </Text>
              <Text dimColor>
                {"  "}Enter select · ↑↓ navigate · ←→ page · N new · Esc cancel
              </Text>
            </Box>
          }
        />
      )}
    </OverlayShell>
  );
}
