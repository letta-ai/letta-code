import type { Letta } from "@letta-ai/letta-client";
import type { MessageSearchResponse } from "@letta-ai/letta-client/resources/messages";
import { Box, Text, useInput } from "ink";
import Link from "ink-link";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface MessageSearchProps {
  onClose: () => void;
  initialQuery?: string;
}

const DISPLAY_PAGE_SIZE = 5;
const SEARCH_LIMIT = 100; // Max results from API

type SearchMode = "hybrid" | "vector" | "fts";
const SEARCH_MODES: SearchMode[] = ["hybrid", "vector", "fts"];

/**
 * Format a relative time string from a date
 */
function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";

  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffWeeks = Math.floor(diffDays / 7);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${diffWeeks}w ago`;
}

/**
 * Format a timestamp in local timezone
 */
function formatLocalTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "";

  const date = new Date(dateStr);
  // Format: "Dec 15, 6:30 PM" or "Dec 15, 2024, 6:30 PM" depending on year
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();

  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    hour: "numeric",
    minute: "2-digit",
  };

  return date.toLocaleString(undefined, options);
}

/**
 * Truncate text to fit width, adding ellipsis if needed
 */
function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  return `${text.slice(0, maxWidth - 3)}...`;
}

/**
 * Get display text from a message
 */
function getMessageText(msg: MessageSearchResponse[number]): string {
  // Assistant message content
  if ("content" in msg) {
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      const textPart = content.find(
        (c) => typeof c === "object" && c && "text" in c,
      );
      if (textPart && typeof textPart === "object" && "text" in textPart) {
        return String(textPart.text);
      }
    }
  }
  // Text field (user messages, etc)
  if ("text" in msg && typeof msg.text === "string") {
    return msg.text;
  }
  // Reasoning messages
  if ("reasoning" in msg && typeof msg.reasoning === "string") {
    return msg.reasoning;
  }
  // Tool call messages
  if ("tool_call" in msg && msg.tool_call) {
    const tc = msg.tool_call as { name?: string; arguments?: string };
    return `Tool: ${tc.name || "unknown"}`;
  }
  // Tool return messages - show tool name and preview of return
  if ("tool_return" in msg) {
    const toolName = "name" in msg ? (msg.name as string) : "tool";
    const returnValue = msg.tool_return as string;
    // Truncate long return values
    const preview = returnValue?.slice(0, 100) || "";
    return `${toolName}: ${preview}`;
  }
  return `[${msg.message_type || "unknown"}]`;
}

export function MessageSearch({ onClose, initialQuery }: MessageSearchProps) {
  const terminalWidth = useTerminalWidth();
  const [searchInput, setSearchInput] = useState(initialQuery ?? "");
  const [activeQuery, setActiveQuery] = useState(initialQuery ?? "");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [results, setResults] = useState<MessageSearchResponse>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const clientRef = useRef<Letta | null>(null);

  // Execute search
  const executeSearch = useCallback(async (query: string, mode: SearchMode) => {
    if (!query.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const client = clientRef.current || (await getClient());
      clientRef.current = client;

      // Direct API call since client.messages.search doesn't exist yet in SDK
      const searchResults = await client.post<MessageSearchResponse>(
        "/v1/messages/search",
        {
          body: {
            query: query.trim(),
            search_mode: mode,
            limit: SEARCH_LIMIT,
          },
        },
      );

      setResults(searchResults);
      setCurrentPage(0);
      setSelectedIndex(0);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Submit search
  const submitSearch = useCallback(() => {
    if (searchInput.trim() && searchInput !== activeQuery) {
      setActiveQuery(searchInput);
      executeSearch(searchInput, searchMode);
    }
  }, [searchInput, activeQuery, searchMode, executeSearch]);

  // Clear search
  const clearSearch = useCallback(() => {
    setSearchInput("");
    setActiveQuery("");
    setResults([]);
    setCurrentPage(0);
    setSelectedIndex(0);
  }, []);

  // Cycle search mode
  const cycleSearchMode = useCallback(() => {
    setSearchMode((current) => {
      const currentIndex = SEARCH_MODES.indexOf(current);
      const nextIndex = (currentIndex + 1) % SEARCH_MODES.length;
      return SEARCH_MODES[nextIndex] as SearchMode;
    });
  }, []);

  // Re-run search when mode changes (if there's an active query)
  useEffect(() => {
    if (activeQuery) {
      executeSearch(activeQuery, searchMode);
    }
  }, [searchMode, activeQuery, executeSearch]);

  // Calculate pagination
  const totalPages = Math.ceil(results.length / DISPLAY_PAGE_SIZE);
  const startIndex = currentPage * DISPLAY_PAGE_SIZE;
  const pageResults = results.slice(startIndex, startIndex + DISPLAY_PAGE_SIZE);

  useInput((input, key) => {
    // CTRL-C: immediately close (bypasses search clearing)
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    if (key.escape) {
      if (searchInput || activeQuery) {
        clearSearch();
      } else {
        onClose();
      }
    } else if (key.return) {
      submitSearch();
    } else if (key.backspace || key.delete) {
      setSearchInput((prev) => prev.slice(0, -1));
    } else if (key.tab) {
      // Tab cycles search mode
      cycleSearchMode();
    } else if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(pageResults.length - 1, prev + 1));
    } else if (input === "j" || input === "J") {
      // Previous page
      if (currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(0);
      }
    } else if (input === "k" || input === "K") {
      // Next page
      if (currentPage < totalPages - 1) {
        setCurrentPage((prev) => prev + 1);
        setSelectedIndex(0);
      }
    } else if (input && !key.ctrl && !key.meta) {
      setSearchInput((prev) => prev + input);
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Search messages across all agents
        </Text>
      </Box>

      {/* Search input and mode */}
      <Box flexDirection="column">
        <Box>
          <Text dimColor>Search: </Text>
          {searchInput ? (
            <>
              <Text>{searchInput}</Text>
              {searchInput !== activeQuery && (
                <Text dimColor> (press Enter to search)</Text>
              )}
            </>
          ) : (
            <Text dimColor italic>
              (type your query)
            </Text>
          )}
        </Box>
        <Box>
          <Text dimColor>Mode: </Text>
          {SEARCH_MODES.map((mode, i) => (
            <Text key={mode}>
              {i > 0 && <Text dimColor> · </Text>}
              <Text
                bold={mode === searchMode}
                color={
                  mode === searchMode
                    ? colors.selector.itemHighlighted
                    : undefined
                }
              >
                {mode}
              </Text>
            </Text>
          ))}
          <Text dimColor> (Tab to change)</Text>
        </Box>
      </Box>

      {/* Error state */}
      {error && (
        <Box>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Loading state */}
      {loading && (
        <Box>
          <Text dimColor>Searching...</Text>
        </Box>
      )}

      {/* No results */}
      {!loading && activeQuery && results.length === 0 && (
        <Box>
          <Text dimColor>No results found for "{activeQuery}"</Text>
        </Box>
      )}

      {/* Results list */}
      {!loading && results.length > 0 && (
        <Box flexDirection="column">
          {pageResults.map(
            (msg: MessageSearchResponse[number], index: number) => {
              const isSelected = index === selectedIndex;
              const messageText = getMessageText(msg);
              // All messages have a date field
              const msgWithDate = msg as {
                date?: string;
                created_at?: string;
                agent_id?: string;
                conversation_id?: string;
              };
              const timestamp = msgWithDate.date
                ? formatRelativeTime(msgWithDate.date)
                : "";
              const msgType = (msg.message_type || "unknown").replace(
                "_message",
                "",
              );
              const agentId = msgWithDate.agent_id || "unknown";
              const conversationId = msgWithDate.conversation_id;
              const createdAt = formatLocalTime(msgWithDate.created_at);

              // Calculate available width for message text
              const metaWidth = timestamp.length + msgType.length + 10; // padding
              const availableWidth = Math.max(
                20,
                terminalWidth - metaWidth - 4,
              );
              const displayText = truncateText(
                messageText.replace(/\n/g, " "),
                availableWidth,
              );

              // Use message id + index for guaranteed uniqueness (search can return same message multiple times)
              const msgId =
                "message_id" in msg ? String(msg.message_id) : "result";
              const uniqueKey = `${msgId}-${startIndex + index}`;

              return (
                <Box key={uniqueKey} flexDirection="column" marginBottom={1}>
                  <Box flexDirection="row">
                    <Text
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isSelected ? ">" : " "}
                    </Text>
                    <Text> </Text>
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {displayText}
                    </Text>
                  </Box>
                  <Box flexDirection="row" marginLeft={2}>
                    <Text dimColor>
                      {msgType}
                      {timestamp && ` · ${timestamp}`}
                    </Text>
                    {agentId && (
                      <>
                        <Text dimColor> · </Text>
                        <Link
                          url={`https://app.letta.com/projects/default-project/agents/${agentId}?searchTerm=${encodeURIComponent(activeQuery)}&messageId=${msgId}${conversationId ? `&conversation=${encodeURIComponent(conversationId)}` : ""}`}
                        >
                          <Text color={colors.link.text}>view message</Text>
                        </Link>
                        <Text dimColor> · agent: </Text>
                        <Link
                          url={`https://app.letta.com/projects/default-project/agents/${agentId}${conversationId ? `?conversation=${encodeURIComponent(conversationId)}` : ""}`}
                        >
                          <Text color={colors.link.text}>{agentId}</Text>
                        </Link>
                      </>
                    )}
                    {createdAt && <Text dimColor> · {createdAt}</Text>}
                  </Box>
                </Box>
              );
            },
          )}
        </Box>
      )}

      {/* Footer */}
      <Box flexDirection="column" marginTop={1}>
        {results.length > 0 && (
          <Box>
            <Text dimColor>
              Page {currentPage + 1}/{totalPages || 1} ({results.length}{" "}
              results)
            </Text>
          </Box>
        )}
        <Box>
          <Text dimColor>
            Type + Enter to search · Tab mode · J/K page · Esc close
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
