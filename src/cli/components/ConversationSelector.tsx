import type { Letta } from "@letta-ai/letta-client";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { SYSTEM_ALERT_OPEN, SYSTEM_REMINDER_OPEN } from "../../constants";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

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
const ENRICH_MESSAGE_LIMIT = 3; // Only need 3 messages for preview lines

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
  const clientRef = useRef<Letta | null>(null);

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

  // Selection state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);

  // Enrich a single conversation with message data, updating state in-place
  const enrichConversation = useCallback(
    async (client: Letta, convId: string) => {
      try {
        const messages = await client.conversations.messages.list(convId, {
          limit: ENRICH_MESSAGE_LIMIT,
          order: "desc",
        });
        const chronological = [...messages.getPaginatedItems()].reverse();
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
    [],
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
        const client = clientRef.current || (await getClient());
        clientRef.current = client;

        // Phase 1: Fetch conversation list + default messages in parallel
        const conversationListPromise = client.conversations.list({
          agent_id: agentId,
          limit: FETCH_PAGE_SIZE,
          ...(afterCursor && { after: afterCursor }),
          order: "desc",
          order_by: "last_run_completion",
        });

        // Fetch default conversation in parallel (not sequentially before)
        const defaultPromise: Promise<EnrichedConversation | null> =
          !afterCursor
            ? client.agents.messages
                .list(agentId, {
                  conversation_id: "default",
                  limit: ENRICH_MESSAGE_LIMIT,
                  order: "desc",
                })
                .then((msgs) => {
                  const items = msgs.getPaginatedItems();
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
          messageCount: conv.in_context_message_ids?.length ?? -1,
          enriched: false,
        }));

        // Filter out conversations we know are empty from in_context_message_ids
        const nonEmptyList = unenrichedList.filter(
          (c) => c.messageCount !== 0,
        );

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
          setSelectedIndex(0);
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
            enrichConversation(client, c.conversation.id),
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
          const count = await enrichConversation(
            client,
            item.conversation.id,
          );
          if (count === 0) {
            setConversations((prev) =>
              prev.filter(
                (c) => c.conversation.id !== item.conversation.id,
              ),
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
    [agentId, enrichConversation],
  );

  // Initial load
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  // Re-enrich when page changes (prioritize newly visible unenriched items)
  useEffect(() => {
    const client = clientRef.current;
    if (!client || loading) return;

    const visibleItems = conversations.slice(
      page * DISPLAY_PAGE_SIZE,
      (page + 1) * DISPLAY_PAGE_SIZE,
    );
    const unenriched = visibleItems.filter((c) => !c.enriched);
    if (unenriched.length === 0) return;

    for (const item of unenriched) {
      enrichConversation(client, item.conversation.id);
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

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (loading) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) =>
        Math.min(pageConversations.length - 1, prev + 1),
      );
    } else if (key.return) {
      const selected = pageConversations[selectedIndex];
      if (selected?.conversation.id) {
        onSelect(selected.conversation.id, {
          summary: selected.conversation.summary ?? undefined,
          messageCount: selected.messageCount,
        });
      }
    } else if (key.escape) {
      onCancel();
    } else if (input === "n" || input === "N") {
      // New conversation
      onNewConversation();
    } else if (key.leftArrow) {
      // Previous page
      if (page > 0) {
        setPage((prev) => prev - 1);
        setSelectedIndex(0);
      }
    } else if (key.rightArrow) {
      // Next page
      if (canGoNext) {
        const nextPageIndex = page + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= conversations.length && hasMore) {
          fetchMore();
        }

        if (nextStartIndex < conversations.length) {
          setPage(nextPageIndex);
          setSelectedIndex(0);
        }
      }
    }
  });

  // Render conversation item
  const renderConversationItem = (
    enrichedConv: EnrichedConversation,
    _index: number,
    isSelected: boolean,
  ) => {
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
      const bracket = <Text dimColor>{"⎿  "}</Text>;
      const indent = "   "; // Same width as "⎿  " for alignment

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
      <Box key={conv.id} flexDirection="column" marginBottom={1}>
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
  };

  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /resume"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title */}
      <Box marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Resume a previous conversation
        </Text>
      </Box>

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

      {/* Conversation list */}
      {!loading && !error && conversations.length > 0 && (
        <Box flexDirection="column">
          {pageConversations.map((conv, index) =>
            renderConversationItem(conv, index, index === selectedIndex),
          )}
        </Box>
      )}

      {/* Footer */}
      {!loading &&
        !error &&
        conversations.length > 0 &&
        (() => {
          const footerWidth = Math.max(0, terminalWidth - 2);
          const pageText = `Page ${page + 1}${hasMore ? "+" : `/${totalPages || 1}`}${loadingMore ? " (loading...)" : ""}`;
          const hintsText =
            "Enter select · ↑↓ navigate · ←→ page · N new · Esc cancel";

          return (
            <Box flexDirection="column">
              <Box flexDirection="row">
                <Box width={2} flexShrink={0} />
                <Box flexGrow={1} width={footerWidth}>
                  <MarkdownDisplay text={pageText} dimColor />
                </Box>
              </Box>
              <Box flexDirection="row">
                <Box width={2} flexShrink={0} />
                <Box flexGrow={1} width={footerWidth}>
                  <MarkdownDisplay text={hintsText} dimColor />
                </Box>
              </Box>
            </Box>
          );
        })()}
    </Box>
  );
}
