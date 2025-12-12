import type { Letta } from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface ResumeSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string) => void;
  onCancel: () => void;
}

const DISPLAY_PAGE_SIZE = 5; // How many agents to show per page
const FETCH_PAGE_SIZE = 20; // How many agents to fetch from server at once

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
 * Truncate agent ID with middle ellipsis if it exceeds available width
 * e.g., "agent-6b383e6f-f2df-43ed-ad88-8c832f1129d0" -> "agent-6b3...9d0"
 */
function truncateAgentId(id: string, availableWidth: number): string {
  if (id.length <= availableWidth) return id;
  if (availableWidth < 15) return id.slice(0, availableWidth); // Too narrow for ellipsis
  const prefixLen = Math.floor((availableWidth - 3) / 2); // -3 for "..."
  const suffixLen = availableWidth - 3 - prefixLen;
  return `${id.slice(0, prefixLen)}...${id.slice(-suffixLen)}`;
}

/**
 * Format model string to show provider/model-name
 */
function formatModel(agent: AgentState): string {
  // Prefer the new model field
  if (agent.model) {
    return agent.model;
  }
  // Fall back to llm_config
  if (agent.llm_config?.model) {
    const provider = agent.llm_config.model_endpoint_type || "unknown";
    return `${provider}/${agent.llm_config.model}`;
  }
  return "unknown";
}

export function ResumeSelector({
  currentAgentId,
  onSelect,
  onCancel,
}: ResumeSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const [allAgents, setAllAgents] = useState<AgentState[]>([]); // All fetched agents
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [hasMore, setHasMore] = useState(true);
  const clientRef = useRef<Letta | null>(null);

  // Fetch agents from the server
  const fetchAgents = useCallback(
    async (afterCursor?: string | null, query?: string) => {
      const client = clientRef.current || (await getClient());
      clientRef.current = client;

      const agentList = await client.agents.list({
        limit: FETCH_PAGE_SIZE,
        include: ["agent.blocks"],
        order: "desc",
        order_by: "last_run_completion",
        ...(afterCursor && { after: afterCursor }),
        ...(query && { query_text: query }),
      });

      // Get cursor for next fetch (last item's ID if there are more)
      const cursor =
        agentList.items.length === FETCH_PAGE_SIZE
          ? (agentList.items[agentList.items.length - 1]?.id ?? null)
          : null;

      return {
        agents: agentList.items,
        nextCursor: cursor,
      };
    },
    [],
  );

  // Initial fetch
  useEffect(() => {
    const initialFetch = async () => {
      try {
        const result = await fetchAgents(null, debouncedQuery || undefined);
        setAllAgents(result.agents);
        setNextCursor(result.nextCursor);
        setHasMore(result.nextCursor !== null);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    initialFetch();
  }, [fetchAgents, debouncedQuery]);

  // Debounce search query (300ms delay)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
      // Reset to first page when search changes
      setCurrentPage(0);
      setSelectedIndex(0);
      setAllAgents([]);
      setNextCursor(null);
      setLoading(true);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch more agents when needed
  const fetchMoreAgents = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) return;

    setLoadingMore(true);
    try {
      const result = await fetchAgents(nextCursor, debouncedQuery || undefined);
      setAllAgents((prev) => [...prev, ...result.agents]);
      setNextCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
    } catch (_err) {
      // Silently fail on pagination errors
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, nextCursor, fetchAgents, debouncedQuery]);

  // Calculate display pages from all fetched agents
  const totalDisplayPages = Math.ceil(allAgents.length / DISPLAY_PAGE_SIZE);
  const startIndex = currentPage * DISPLAY_PAGE_SIZE;
  const pageAgents = allAgents.slice(
    startIndex,
    startIndex + DISPLAY_PAGE_SIZE,
  );
  const canGoNext = currentPage < totalDisplayPages - 1 || hasMore;

  useInput((input, key) => {
    if (loading || error) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(pageAgents.length - 1, prev + 1));
    } else if (key.return) {
      const selectedAgent = pageAgents[selectedIndex];
      if (selectedAgent?.id) {
        onSelect(selectedAgent.id);
      }
    } else if (key.escape) {
      onCancel();
    } else if (key.backspace || key.delete) {
      setSearchQuery((prev) => prev.slice(0, -1));
    } else if (input === "j" || input === "J") {
      // Previous page (j = up/back)
      if (currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(0);
      }
    } else if (input === "k" || input === "K") {
      // Next page (k = down/forward)
      if (canGoNext) {
        const nextPageIndex = currentPage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        // Fetch more if we need data for the next page
        if (nextStartIndex >= allAgents.length && hasMore) {
          fetchMoreAgents();
        }

        // Navigate if we have the data
        if (nextStartIndex < allAgents.length) {
          setCurrentPage(nextPageIndex);
          setSelectedIndex(0);
        }
      }
    } else if (input === "/") {
      // Ignore "/" - it's shown in help but just starts typing search
      // Don't add it to the search query
    } else if (input && !key.ctrl && !key.meta) {
      // Add regular characters to search query (searches name and ID)
      setSearchQuery((prev) => prev + input);
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text color={colors.selector.title}>Loading agents...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error loading agents: {error}</Text>
        <Text dimColor>Press ESC to cancel</Text>
      </Box>
    );
  }

  if (!loading && allAgents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={colors.selector.title}>
          {debouncedQuery ? "No matching agents found" : "No agents found"}
        </Text>
        <Text dimColor>Press ESC to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Resume Session
        </Text>
      </Box>

      {searchQuery && (
        <Box>
          <Text dimColor>Search (name/ID): </Text>
          <Text>{searchQuery}</Text>
        </Box>
      )}

      <Box flexDirection="column">
        {pageAgents.map((agent, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = agent.id === currentAgentId;

          const relativeTime = formatRelativeTime(agent.last_run_completion);
          const blockCount = agent.blocks?.length ?? 0;
          const modelStr = formatModel(agent);

          // Calculate available width for agent ID
          // Row format: "> Name · agent-id (current)"
          const nameLen = (agent.name || "Unnamed").length;
          const fixedChars = 2 + 3 + (isCurrent ? 10 : 0); // "> " + " · " + " (current)"
          const availableForId = Math.max(
            15,
            terminalWidth - nameLen - fixedChars,
          );
          const displayId = truncateAgentId(agent.id, availableForId);

          return (
            <Box key={agent.id} flexDirection="column" marginBottom={1}>
              {/* Row 1: Selection indicator, agent name, and ID */}
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
                  {agent.name || "Unnamed"}
                </Text>
                <Text dimColor> · {displayId}</Text>
                {isCurrent && (
                  <Text color={colors.selector.itemCurrent}> (current)</Text>
                )}
              </Box>
              {/* Row 2: Description */}
              <Box flexDirection="row" marginLeft={2}>
                <Text dimColor italic>
                  {agent.description || "No description"}
                </Text>
              </Box>
              {/* Row 3: Metadata (dimmed) */}
              <Box flexDirection="row" marginLeft={2}>
                <Text dimColor>
                  {relativeTime} · {blockCount} memory block
                  {blockCount === 1 ? "" : "s"} · {modelStr}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {/* Footer with pagination and controls */}
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Text dimColor>
            Page {currentPage + 1}
            {hasMore ? "+" : `/${totalDisplayPages || 1}`}
            {loadingMore && " (loading...)"}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            ↑↓ navigate · Enter select · J/K prev/next page · Type to search ·
            Esc cancel
          </Text>
        </Box>
      </Box>
    </Box>
  );
}
