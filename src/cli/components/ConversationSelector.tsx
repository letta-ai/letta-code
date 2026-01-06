import type { Letta } from "@letta-ai/letta-client";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface ConversationSelectorProps {
  agentId: string;
  currentConversationId: string;
  onSelect: (conversationId: string) => void;
  onNewConversation: () => void;
  onCancel: () => void;
}

// Enriched conversation with message data
interface EnrichedConversation {
  conversation: Conversation;
  lastUserMessage: string | null;
  lastActiveAt: string | null;
  messageCount: number;
}

const DISPLAY_PAGE_SIZE = 5;
const FETCH_PAGE_SIZE = 20;

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
        if (part.text.startsWith("<system-reminder>")) continue;
        textToShow = part.text;
        break;
      }
    }
  }

  if (!textToShow) return null;

  // Truncate to a reasonable preview length
  const maxLen = 60;
  if (textToShow.length > maxLen) {
    return `${textToShow.slice(0, maxLen - 3)}...`;
  }
  return textToShow;
}

/**
 * Get the last user message and last activity time from messages
 */
function getMessageStats(messages: Message[]): {
  lastUserMessage: string | null;
  lastActiveAt: string | null;
  messageCount: number;
} {
  if (messages.length === 0) {
    return { lastUserMessage: null, lastActiveAt: null, messageCount: 0 };
  }

  // Find last user message with actual content (searching from end)
  let lastUserMessage: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;

    // Check for user_message type
    if (msg.message_type === "user_message") {
      lastUserMessage = extractUserMessagePreview(msg);
      if (lastUserMessage) break;
    }
  }

  // Last activity is the timestamp of the last message
  // Most message types have a 'date' field for the timestamp
  const lastMessage = messages[messages.length - 1];
  const lastActiveAt =
    (lastMessage as Message & { date?: string }).date ?? null;

  return { lastUserMessage, lastActiveAt, messageCount: messages.length };
}

/**
 * Truncate ID with middle ellipsis if it exceeds available width
 */
function truncateId(id: string, availableWidth: number): string {
  if (id.length <= availableWidth) return id;
  if (availableWidth < 15) return id.slice(0, availableWidth);
  const prefixLen = Math.floor((availableWidth - 3) / 2);
  const suffixLen = availableWidth - 3 - prefixLen;
  return `${id.slice(0, prefixLen)}...${id.slice(-suffixLen)}`;
}

export function ConversationSelector({
  agentId,
  currentConversationId,
  onSelect,
  onNewConversation,
  onCancel,
}: ConversationSelectorProps) {
  const terminalWidth = useTerminalWidth();
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

  // Selection state
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [page, setPage] = useState(0);

  // Load conversations and enrich with message data
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

        const result = await client.conversations.list({
          agent_id: agentId,
          limit: FETCH_PAGE_SIZE,
          ...(afterCursor && { after: afterCursor }),
        });

        // Enrich conversations with message data in parallel
        const enrichedConversations = await Promise.all(
          result.map(async (conv) => {
            try {
              // Fetch messages to get stats
              const messages = await client.conversations.messages.list(
                conv.id,
              );
              const stats = getMessageStats(messages);
              return {
                conversation: conv,
                lastUserMessage: stats.lastUserMessage,
                lastActiveAt: stats.lastActiveAt,
                messageCount: stats.messageCount,
              };
            } catch {
              // If we fail to fetch messages, show conversation anyway with -1 to indicate error
              return {
                conversation: conv,
                lastUserMessage: null,
                lastActiveAt: null,
                messageCount: -1, // Unknown, don't filter out
              };
            }
          }),
        );

        // Filter out empty conversations (messageCount === 0)
        // Keep conversations with messageCount > 0 or -1 (error/unknown)
        const nonEmptyConversations = enrichedConversations.filter(
          (c) => c.messageCount !== 0,
        );

        const newCursor =
          result.length === FETCH_PAGE_SIZE
            ? (result[result.length - 1]?.id ?? null)
            : null;

        if (isLoadingMore) {
          setConversations((prev) => [...prev, ...nonEmptyConversations]);
        } else {
          setConversations(nonEmptyConversations);
          setPage(0);
          setSelectedIndex(0);
        }
        setCursor(newCursor);
        setHasMore(newCursor !== null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isLoadingMore) {
          setLoadingMore(false);
        } else {
          setLoading(false);
        }
      }
    },
    [agentId],
  );

  // Initial load
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

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
        onSelect(selected.conversation.id);
      }
    } else if (key.escape) {
      onCancel();
    } else if (input === "n" || input === "N") {
      // New conversation
      onNewConversation();
    } else if (input === "j" || input === "J") {
      // Previous page
      if (page > 0) {
        setPage((prev) => prev - 1);
        setSelectedIndex(0);
      }
    } else if (input === "k" || input === "K") {
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
      lastUserMessage,
      lastActiveAt,
      messageCount,
    } = enrichedConv;
    const isCurrent = conv.id === currentConversationId;
    const displayId = truncateId(conv.id, Math.min(40, terminalWidth - 30));

    // Format timestamps
    const activeTime = formatRelativeTime(lastActiveAt);
    const createdTime = formatRelativeTime(conv.created_at);

    // Preview text: prefer last user message, fall back to summary or message count
    let previewText: string;
    if (lastUserMessage) {
      previewText = lastUserMessage;
    } else if (conv.summary) {
      previewText = conv.summary;
    } else if (messageCount > 0) {
      previewText = `${messageCount} message${messageCount === 1 ? "" : "s"}`;
    } else {
      previewText = "No preview";
    }

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
            {displayId}
          </Text>
          {isCurrent && (
            <Text color={colors.selector.itemCurrent}> (current)</Text>
          )}
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor italic>
            {previewText}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>
            Active {activeTime} · Created {createdTime}
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column">
      {/* Header */}
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Resume Conversation
        </Text>
        <Text dimColor>Select a conversation to resume or start a new one</Text>
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

      {/* Empty state */}
      {!loading && !error && conversations.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>No conversations found</Text>
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
      {!loading && !error && conversations.length > 0 && (
        <Box flexDirection="column">
          <Box>
            <Text dimColor>
              Page {page + 1}
              {hasMore ? "+" : `/${totalPages || 1}`}
              {loadingMore ? " (loading...)" : ""}
            </Text>
          </Box>
          <Box>
            <Text dimColor>
              ↑↓ navigate · Enter select · J/K page · N new · ESC cancel
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
