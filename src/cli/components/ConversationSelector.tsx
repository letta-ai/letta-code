import type { Letta } from "@letta-ai/letta-client";
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface ConversationSelectorProps {
  agentId: string;
  agentName?: string;
  currentConversationId: string;
  onSelect: (conversationId: string) => void;
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
  previewLines: PreviewLine[]; // Last 1-3 user/assistant messages
  lastActiveAt: string | null;
  messageCount: number;
}

const DISPLAY_PAGE_SIZE = 3;
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

        // Fetch default conversation data (agent's primary message history)
        // Only fetch on initial load (not when paginating)
        let defaultConversation: EnrichedConversation | null = null;
        if (!afterCursor) {
          try {
            const defaultMessages = await client.agents.messages.list(agentId, {
              limit: 20,
              order: "desc",
              conversation_id: "default", // Filter to default conversation only
            });
            const defaultMsgItems = defaultMessages.items;
            if (defaultMsgItems.length > 0) {
              const defaultStats = getMessageStats(
                [...defaultMsgItems].reverse(),
              );
              defaultConversation = {
                conversation: {
                  id: "default",
                  agent_id: agentId,
                  created_at: new Date().toISOString(),
                } as Conversation,
                previewLines: defaultStats.previewLines,
                lastActiveAt: defaultStats.lastActiveAt,
                messageCount: defaultStats.messageCount,
              };
            }
          } catch {
            // If we can't fetch default messages, just skip showing it
          }
        }

        const result = await client.conversations.list({
          agent_id: agentId,
          limit: FETCH_PAGE_SIZE,
          ...(afterCursor && { after: afterCursor }),
        });

        // Enrich conversations with message data in parallel
        const enrichedConversations = await Promise.all(
          result.map(async (conv) => {
            try {
              // Fetch recent messages to get stats (desc order = newest first)
              const messages = await client.conversations.messages.list(
                conv.id,
                { limit: 20, order: "desc" },
              );
              // Reverse to chronological for getMessageStats (expects oldest-first)
              const chronologicalMessages = [
                ...messages.getPaginatedItems(),
              ].reverse();
              const stats = getMessageStats(chronologicalMessages);
              return {
                conversation: conv,
                previewLines: stats.previewLines,
                lastActiveAt: stats.lastActiveAt,
                messageCount: stats.messageCount,
              };
            } catch {
              // If we fail to fetch messages, show conversation anyway with -1 to indicate error
              return {
                conversation: conv,
                previewLines: [],
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
          // Prepend default conversation to the list (if it has messages)
          const allConversations = defaultConversation
            ? [defaultConversation, ...nonEmptyConversations]
            : nonEmptyConversations;
          setConversations(allConversations);
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

      // Priority 1: Summary
      if (conv.summary) {
        return (
          <Box flexDirection="row" marginLeft={2}>
            {bracket}
            <Text dimColor italic>
              {conv.summary.length > 57
                ? `${conv.summary.slice(0, 54)}...`
                : conv.summary}
            </Text>
          </Box>
        );
      }

      // Priority 2: Preview lines with emoji prefixes
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
            {isDefault ? "default" : conv.id}
          </Text>
          {isDefault && <Text dimColor> (agent's default conversation)</Text>}
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
