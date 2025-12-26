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
  const [searchInput, setSearchInput] = useState(""); // What user is typing
  const [activeQuery, setActiveQuery] = useState(""); // Submitted search query
  const [hasMore, setHasMore] = useState(true);
  const [filterLettaCode, setFilterLettaCode] = useState(true); // Filter to only letta-code agents
  const clientRef = useRef<Letta | null>(null);

  // Fetch agents from the server
  const fetchAgents = useCallback(
    async (afterCursor?: string | null, query?: string) => {
      const client = clientRef.current || (await getClient());
      clientRef.current = client;

      const agentList = await client.agents.list({
        limit: FETCH_PAGE_SIZE,
        ...(filterLettaCode && { tags: ["origin:letta-code"] }),
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
    [filterLettaCode],
  );

  // Fetch agents when activeQuery changes (initial load or search submitted)
  useEffect(() => {
    const doFetch = async () => {
      setLoading(true);
      try {
        const result = await fetchAgents(null, activeQuery || undefined);
        setAllAgents(result.agents);
        setNextCursor(result.nextCursor);
        setHasMore(result.nextCursor !== null);
        setCurrentPage(0);
        setSelectedIndex(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    doFetch();
  }, [fetchAgents, activeQuery]);

  // Submit search (called when Enter is pressed while typing search)
  const submitSearch = useCallback(() => {
    if (searchInput !== activeQuery) {
      setActiveQuery(searchInput);
    }
  }, [searchInput, activeQuery]);

  // Clear search
  const clearSearch = useCallback(() => {
    setSearchInput("");
    if (activeQuery) {
      setActiveQuery("");
    }
  }, [activeQuery]);

  // Fetch more agents when needed
  const fetchMoreAgents = useCallback(async () => {
    if (loadingMore || !hasMore || !nextCursor) return;

    setLoadingMore(true);
    try {
      const result = await fetchAgents(nextCursor, activeQuery || undefined);
      setAllAgents((prev) => [...prev, ...result.agents]);
      setNextCursor(result.nextCursor);
      setHasMore(result.nextCursor !== null);
    } catch (_err) {
      // Silently fail on pagination errors
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, nextCursor, fetchAgents, activeQuery]);

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
      // If typing a search query, submit it; otherwise select agent
      if (searchInput && searchInput !== activeQuery) {
        submitSearch();
      } else {
        const selectedAgent = pageAgents[selectedIndex];
        if (selectedAgent?.id) {
          onSelect(selectedAgent.id);
        }
      }
    } else if (key.escape) {
      // If typing search, clear it first; otherwise cancel
      if (searchInput) {
        clearSearch();
      } else {
        onCancel();
      }
    } else if (key.backspace || key.delete) {
      setSearchInput((prev) => prev.slice(0, -1));
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
      // Ignore "/" - just starts typing search
    } else if (input === "a" || input === "A") {
      // Toggle filter between letta-code agents and all agents
      setFilterLettaCode((prev) => !prev);
    } else if (input && !key.ctrl && !key.meta) {
      // Add regular characters to search input
      setSearchInput((prev) => prev + input);
    }
  });

  // Always show the header, with contextual content below
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Browsing Agents (sorting by last run)
        </Text>
        <Text dimColor>
          {filterLettaCode
            ? "Displaying agents created in Letta Code (press A to show all)"
            : "Displaying all agents (press A to filter to Letta Code)"}
        </Text>
      </Box>

      {/* Search input - show when typing or when there's an active search */}
      {(searchInput || activeQuery) && (
        <Box>
          <Text dimColor>Search: </Text>
          <Text>{searchInput}</Text>
          {searchInput && searchInput !== activeQuery && (
            <Text dimColor> (press Enter to search)</Text>
          )}
          {activeQuery && searchInput === activeQuery && (
            <Text dimColor> (Esc to clear)</Text>
          )}
        </Box>
      )}

      {/* Error state */}
      {error && (
        <Box flexDirection="column">
          <Text color="red">Error: {error}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Loading state */}
      {loading && !error && (
        <Box>
          <Text dimColor>Loading agents...</Text>
        </Box>
      )}

      {/* Empty state */}
      {!loading && !error && allAgents.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>
            {activeQuery ? "No matching agents found" : "No agents found"}
          </Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Agent list - only show when loaded and have agents */}
      {!loading && !error && allAgents.length > 0 && (
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
      )}

      {/* Footer with pagination and controls - only show when loaded with agents */}
      {!loading && !error && allAgents.length > 0 && (
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
              ↑↓ navigate · Enter select · J/K page · Type to search
            </Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
