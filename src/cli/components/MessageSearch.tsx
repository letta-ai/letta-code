import type { Letta } from "@letta-ai/letta-client";
import type { MessageSearchResponse } from "@letta-ai/letta-client/resources/messages";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface MessageSearchProps {
  onClose: () => void;
  initialQuery?: string;
  /** Current agent ID for "current agent" filter */
  agentId?: string;
  /** Current conversation ID for "current conv" filter */
  conversationId?: string;
  /** Callback when user wants to open a conversation */
  onOpenConversation?: (agentId: string, conversationId?: string) => void;
}

const VISIBLE_ITEMS = 5;
const SEARCH_LIMIT = 100; // Max results from API

type SearchMode = "hybrid" | "vector" | "fts";
const SEARCH_MODES: SearchMode[] = ["fts", "vector", "hybrid"]; // Display order (hybrid is default)

type SearchRange = "all" | "agent" | "conv";
const SEARCH_RANGES: SearchRange[] = ["all", "agent", "conv"];

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

export function MessageSearch({
  onClose,
  initialQuery,
  agentId,
  conversationId,
  onOpenConversation,
}: MessageSearchProps) {
  const terminalWidth = useTerminalWidth();
  const [searchInput, setSearchInput] = useState(initialQuery ?? "");
  const [activeQuery, setActiveQuery] = useState(initialQuery ?? "");
  const [searchMode, setSearchMode] = useState<SearchMode>("hybrid");
  const [searchRange, setSearchRange] = useState<SearchRange>("all");
  const [results, setResults] = useState<MessageSearchResponse>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedMessage, setExpandedMessage] = useState<
    MessageSearchResponse[number] | null
  >(null);
  const clientRef = useRef<Letta | null>(null);
  // Cache results per query+mode+range combination to avoid re-fetching
  const resultsCache = useRef<Map<string, MessageSearchResponse>>(new Map());

  // Get cache key for a specific query+mode+range combination
  const getCacheKey = useCallback(
    (query: string, mode: SearchMode, range: SearchRange) => {
      const rangeKey =
        range === "agent"
          ? agentId || "no-agent"
          : range === "conv"
            ? conversationId || "no-conv"
            : "all";
      return `${query.trim()}-${mode}-${rangeKey}`;
    },
    [agentId, conversationId],
  );

  // Execute search for a single mode (returns results, doesn't set state)
  const fetchSearchResults = useCallback(
    async (
      client: Letta,
      query: string,
      mode: SearchMode,
      range: SearchRange,
    ) => {
      const body: Record<string, unknown> = {
        query: query.trim(),
        search_mode: mode,
        limit: SEARCH_LIMIT,
      };

      // Add filters based on range
      if (range === "agent" && agentId) {
        body.agent_id = agentId;
      } else if (range === "conv" && conversationId) {
        body.conversation_id = conversationId;
      }

      const searchResults = await client.post<MessageSearchResponse>(
        "/v1/messages/search",
        { body },
      );
      return searchResults;
    },
    [agentId, conversationId],
  );

  // Execute search - fires all 9 combinations (3 modes × 3 ranges) in parallel
  const executeSearch = useCallback(
    async (query: string, mode: SearchMode, range: SearchRange) => {
      if (!query.trim()) return;

      const cacheKey = getCacheKey(query, mode, range);

      // Check cache first
      const cached = resultsCache.current.get(cacheKey);
      if (cached) {
        setResults(cached);
        setSelectedIndex(0);
        return;
      }

      setLoading(true);
      setError(null);

      try {
        const client = clientRef.current || (await getClient());
        clientRef.current = client;

        // Helper to get cached or fetch
        const getOrFetch = (m: SearchMode, r: SearchRange) => {
          const key = getCacheKey(query, m, r);
          return (
            resultsCache.current.get(key) ??
            fetchSearchResults(client, query, m, r)
          );
        };

        // Fire all 9 combinations in parallel for instant mode/range switching
        const [
          hybridAll,
          vectorAll,
          ftsAll,
          hybridAgent,
          vectorAgent,
          ftsAgent,
          hybridConv,
          vectorConv,
          ftsConv,
        ] = await Promise.all([
          getOrFetch("hybrid", "all"),
          getOrFetch("vector", "all"),
          getOrFetch("fts", "all"),
          agentId ? getOrFetch("hybrid", "agent") : Promise.resolve([]),
          agentId ? getOrFetch("vector", "agent") : Promise.resolve([]),
          agentId ? getOrFetch("fts", "agent") : Promise.resolve([]),
          conversationId ? getOrFetch("hybrid", "conv") : Promise.resolve([]),
          conversationId ? getOrFetch("vector", "conv") : Promise.resolve([]),
          conversationId ? getOrFetch("fts", "conv") : Promise.resolve([]),
        ]);

        // Cache all results
        resultsCache.current.set(
          getCacheKey(query, "hybrid", "all"),
          hybridAll,
        );
        resultsCache.current.set(
          getCacheKey(query, "vector", "all"),
          vectorAll,
        );
        resultsCache.current.set(getCacheKey(query, "fts", "all"), ftsAll);
        if (agentId) {
          resultsCache.current.set(
            getCacheKey(query, "hybrid", "agent"),
            hybridAgent,
          );
          resultsCache.current.set(
            getCacheKey(query, "vector", "agent"),
            vectorAgent,
          );
          resultsCache.current.set(
            getCacheKey(query, "fts", "agent"),
            ftsAgent,
          );
        }
        if (conversationId) {
          resultsCache.current.set(
            getCacheKey(query, "hybrid", "conv"),
            hybridConv,
          );
          resultsCache.current.set(
            getCacheKey(query, "vector", "conv"),
            vectorConv,
          );
          resultsCache.current.set(getCacheKey(query, "fts", "conv"), ftsConv);
        }

        // Set the results for the current mode+range
        const resultMap: Record<
          SearchMode,
          Record<SearchRange, MessageSearchResponse>
        > = {
          hybrid: { all: hybridAll, agent: hybridAgent, conv: hybridConv },
          vector: { all: vectorAll, agent: vectorAgent, conv: vectorConv },
          fts: { all: ftsAll, agent: ftsAgent, conv: ftsConv },
        };

        setResults(resultMap[mode][range]);
        setSelectedIndex(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setResults([]);
      } finally {
        setLoading(false);
      }
    },
    [fetchSearchResults, getCacheKey, agentId, conversationId],
  );

  // Submit search (only when query changes)
  const submitSearch = useCallback(() => {
    if (searchInput.trim() && searchInput !== activeQuery) {
      setActiveQuery(searchInput);
      executeSearch(searchInput, searchMode, searchRange);
    }
  }, [searchInput, activeQuery, searchMode, searchRange, executeSearch]);

  // Clear search
  const clearSearch = useCallback(() => {
    setSearchInput("");
    setActiveQuery("");
    setResults([]);
    setSelectedIndex(0);
  }, []);

  // Cycle search mode (Shift+Tab)
  const cycleSearchMode = useCallback((reverse = false) => {
    setSearchMode((current) => {
      const currentIndex = SEARCH_MODES.indexOf(current);
      const nextIndex = reverse
        ? (currentIndex - 1 + SEARCH_MODES.length) % SEARCH_MODES.length
        : (currentIndex + 1) % SEARCH_MODES.length;
      return SEARCH_MODES[nextIndex] as SearchMode;
    });
  }, []);

  // Cycle search range (Tab)
  const cycleSearchRange = useCallback(() => {
    setSearchRange((current) => {
      const currentIndex = SEARCH_RANGES.indexOf(current);
      const nextIndex = (currentIndex + 1) % SEARCH_RANGES.length;
      return SEARCH_RANGES[nextIndex] as SearchRange;
    });
  }, []);

  // Re-run search when mode or range changes (if there's an active query) - uses cache
  useEffect(() => {
    if (activeQuery) {
      executeSearch(activeQuery, searchMode, searchRange);
    }
  }, [searchMode, searchRange, activeQuery, executeSearch]);

  // Sliding window for visible items
  const startIndex = Math.max(
    0,
    Math.min(selectedIndex - 2, results.length - VISIBLE_ITEMS),
  );
  const visibleResults = results.slice(startIndex, startIndex + VISIBLE_ITEMS);

  useInput((input, key) => {
    // CTRL-C: immediately close (bypasses search clearing)
    if (key.ctrl && input === "c") {
      onClose();
      return;
    }

    // Handle expanded message view
    if (expandedMessage) {
      if (key.escape) {
        setExpandedMessage(null);
      } else if (key.return && onOpenConversation) {
        const msgData = expandedMessage as {
          agent_id?: string;
          conversation_id?: string;
        };
        if (msgData.agent_id) {
          onOpenConversation(msgData.agent_id, msgData.conversation_id);
        }
      }
      return;
    }

    if (key.escape) {
      if (searchInput || activeQuery) {
        clearSearch();
      } else {
        onClose();
      }
    } else if (key.return) {
      // If user has typed a new query, search first
      if (searchInput.trim() && searchInput !== activeQuery) {
        submitSearch();
      } else if (results.length > 0 && results[selectedIndex]) {
        // Otherwise expand the selected result
        setExpandedMessage(results[selectedIndex]);
      }
    } else if (key.backspace || key.delete) {
      setSearchInput((prev) => prev.slice(0, -1));
    } else if (key.tab && key.shift) {
      // Shift+Tab cycles search mode
      cycleSearchMode();
    } else if (key.tab) {
      // Tab cycles search range
      cycleSearchRange();
    } else if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(results.length - 1, prev + 1));
    } else if (input && !key.ctrl && !key.meta) {
      setSearchInput((prev) => prev + input);
    }
  });

  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  // Range label helper
  const getRangeLabel = (range: SearchRange) => {
    switch (range) {
      case "all":
        return "all agents";
      case "agent":
        return "this agent";
      case "conv":
        return "this conversation";
    }
  };

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /search"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Expanded message view - hide title/controls */}
      {expandedMessage &&
        (() => {
          const msgData = expandedMessage as {
            date?: string;
            created_at?: string;
            agent_id?: string;
            conversation_id?: string;
          };
          const fullText = getMessageText(expandedMessage);
          const msgType = expandedMessage.message_type || "unknown";
          const isAssistant =
            msgType === "assistant_message" || msgType === "reasoning_message";
          const typeLabel = isAssistant ? "Agent message" : "User message";
          const timestamp = formatLocalTime(msgData.created_at || msgData.date);

          return (
            <>
              {/* Full message text in quotes */}
              <Box paddingLeft={2}>
                <Text>"{fullText}"</Text>
              </Box>

              <Box height={1} />

              {/* Metadata */}
              <Box flexDirection="column" paddingLeft={2}>
                <Text dimColor>
                  {typeLabel}, sent {timestamp}
                </Text>
                <Text dimColor>Agent ID: {msgData.agent_id || "unknown"}</Text>
                {msgData.conversation_id && (
                  <Text dimColor>Conv ID: {msgData.conversation_id}</Text>
                )}
              </Box>

              <Box height={1} />

              {/* Footer */}
              <Box paddingLeft={2}>
                <Text dimColor>
                  {onOpenConversation
                    ? "Enter to open conversation · Esc cancel"
                    : "Esc cancel"}
                </Text>
              </Box>
            </>
          );
        })()}

      {/* Title and search controls - hidden when expanded */}
      {!expandedMessage && (
        <Box flexDirection="column" gap={1} marginBottom={1}>
          <Text bold color={colors.selector.title}>
            Search messages across all agents
          </Text>
          <Box flexDirection="column" paddingLeft={1}>
            {/* Search input */}
            <Box flexDirection="row">
              <Text dimColor> Search: </Text>
              {searchInput ? (
                <>
                  <Text>{searchInput}</Text>
                  {searchInput !== activeQuery && (
                    <Text dimColor> (press Enter to search)</Text>
                  )}
                </>
              ) : (
                <Text dimColor>(type to search)</Text>
              )}
            </Box>

            <Box height={1} />

            {/* Range tabs */}
            <Box flexDirection="row">
              <Text dimColor> Range (tab): </Text>
              {SEARCH_RANGES.map((range, i) => {
                const isActive = range === searchRange;
                return (
                  <Text key={range}>
                    {i > 0 && <Text> </Text>}
                    <Text
                      backgroundColor={
                        isActive ? colors.selector.itemHighlighted : undefined
                      }
                      color={isActive ? "black" : undefined}
                      bold={isActive}
                    >
                      {` ${getRangeLabel(range)} `}
                    </Text>
                  </Text>
                );
              })}
            </Box>

            {/* Mode tabs */}
            <Box flexDirection="row">
              <Text dimColor> Mode (shift-tab): </Text>
              {SEARCH_MODES.map((mode, i) => {
                const isActive = mode === searchMode;
                return (
                  <Text key={mode}>
                    {i > 0 && <Text> </Text>}
                    <Text
                      backgroundColor={
                        isActive ? colors.selector.itemHighlighted : undefined
                      }
                      color={isActive ? "black" : undefined}
                      bold={isActive}
                    >
                      {` ${mode} `}
                    </Text>
                  </Text>
                );
              })}
            </Box>
          </Box>
        </Box>
      )}

      {/* Error state */}
      {!expandedMessage && error && (
        <Box paddingLeft={2}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}

      {/* Loading state */}
      {!expandedMessage && loading && (
        <Box paddingLeft={2}>
          <Text dimColor>Searching...</Text>
        </Box>
      )}

      {/* No results */}
      {!expandedMessage && !loading && activeQuery && results.length === 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>No results found for "{activeQuery}"</Text>
        </Box>
      )}

      {/* Results list */}
      {!expandedMessage && !loading && results.length > 0 && (
        <Box flexDirection="column">
          {visibleResults.map(
            (msg: MessageSearchResponse[number], visibleIndex: number) => {
              const actualIndex = startIndex + visibleIndex;
              const isSelected = actualIndex === selectedIndex;
              const messageText = getMessageText(msg);
              // All messages have a date field
              const msgWithDate = msg as {
                date?: string;
                created_at?: string;
                agent_id?: string;
                conversation_id?: string;
              };
              const msgType = msg.message_type || "unknown";
              const agentIdFromMsg = msgWithDate.agent_id || "unknown";
              const conversationIdFromMsg = msgWithDate.conversation_id;
              const createdAt = formatLocalTime(
                msgWithDate.created_at || msgWithDate.date,
              );

              // Determine emoji based on message type
              const isAssistant =
                msgType === "assistant_message" ||
                msgType === "reasoning_message";
              const emoji = isAssistant ? "👾" : "👤";

              // Calculate available width for message text (account for emoji + spacing)
              const availableWidth = Math.max(20, terminalWidth - 8);
              const displayText = truncateText(
                messageText.replace(/\n/g, " "),
                availableWidth,
              );

              // Show conversation_id if exists, otherwise agent_id
              const idToShow = conversationIdFromMsg || agentIdFromMsg;

              // Use message id + index for guaranteed uniqueness (search can return same message multiple times)
              const msgId =
                "message_id" in msg ? String(msg.message_id) : "result";
              const uniqueKey = `${msgId}-${actualIndex}`;

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
                    <Text> {emoji} </Text>
                    <Text
                      bold={isSelected}
                      italic
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {displayText}
                    </Text>
                  </Box>
                  <Box flexDirection="row" marginLeft={2}>
                    <Text dimColor>
                      {createdAt}
                      {idToShow && ` · ${idToShow}`}
                    </Text>
                  </Box>
                </Box>
              );
            },
          )}
        </Box>
      )}

      {/* Footer */}
      {!expandedMessage && (
        <Box flexDirection="column" marginTop={1} paddingLeft={2}>
          {results.length > 0 && (
            <Text dimColor>
              {selectedIndex + 1}/{results.length} results
            </Text>
          )}
          <Text dimColor>Enter expand · ↑↓ navigate · Esc close</Text>
        </Box>
      )}
    </Box>
  );
}
