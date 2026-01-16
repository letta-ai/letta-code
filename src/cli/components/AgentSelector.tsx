import type { Letta } from "@letta-ai/letta-client";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { getModelDisplayName } from "../../agent/model";
import { settingsManager } from "../../settings-manager";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string) => void;
  onCancel: () => void;
  /** Called when user presses N to create a new agent */
  onCreateNewAgent?: () => void;
  /** The command that triggered this selector (e.g., "/agents" or "/resume") */
  command?: string;
}

type TabId = "pinned" | "letta-code" | "all";

interface PinnedAgentData {
  agentId: string;
  agent: AgentState | null;
  error: string | null;
  isLocal: boolean;
}

const TABS: { id: TabId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "letta-code", label: "Letta Code" },
  { id: "all", label: "All" },
];

const TAB_DESCRIPTIONS: Record<TabId, string> = {
  pinned: "Save agents for easy access by pinning them with /pin",
  "letta-code": "Displaying agents created inside of Letta Code",
  all: "Displaying all available agents",
};

const TAB_EMPTY_STATES: Record<TabId, string> = {
  pinned: "No pinned agents, use /pin to save",
  "letta-code": "No agents with tag 'origin:letta-code'",
  all: "No agents found",
};

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
 * Truncate agent ID with middle ellipsis if it exceeds available width
 */
function truncateAgentId(id: string, availableWidth: number): string {
  if (id.length <= availableWidth) return id;
  if (availableWidth < 15) return id.slice(0, availableWidth);
  const prefixLen = Math.floor((availableWidth - 3) / 2);
  const suffixLen = availableWidth - 3 - prefixLen;
  return `${id.slice(0, prefixLen)}...${id.slice(-suffixLen)}`;
}

/**
 * Format model string to show friendly display name (e.g., "Sonnet 4.5")
 */
function formatModel(agent: AgentState): string {
  // Build handle from agent config
  let handle: string | null = null;
  if (agent.model) {
    handle = agent.model;
  } else if (agent.llm_config?.model) {
    const provider = agent.llm_config.model_endpoint_type || "unknown";
    handle = `${provider}/${agent.llm_config.model}`;
  }

  if (handle) {
    // Try to get friendly display name
    const displayName = getModelDisplayName(handle);
    if (displayName) return displayName;
    // Fallback to handle
    return handle;
  }
  return "unknown";
}

export function AgentSelector({
  currentAgentId,
  onSelect,
  onCancel,
  onCreateNewAgent,
  command = "/agents",
}: AgentSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const clientRef = useRef<Letta | null>(null);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>("pinned");

  // Pinned tab state
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgentData[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedSelectedIndex, setPinnedSelectedIndex] = useState(0);
  const [pinnedPage, setPinnedPage] = useState(0);

  // Letta Code tab state (cached separately)
  const [lettaCodeAgents, setLettaCodeAgents] = useState<AgentState[]>([]);
  const [lettaCodeCursor, setLettaCodeCursor] = useState<string | null>(null);
  const [lettaCodeLoading, setLettaCodeLoading] = useState(false);
  const [lettaCodeLoadingMore, setLettaCodeLoadingMore] = useState(false);
  const [lettaCodeHasMore, setLettaCodeHasMore] = useState(true);
  const [lettaCodeSelectedIndex, setLettaCodeSelectedIndex] = useState(0);
  const [lettaCodePage, setLettaCodePage] = useState(0);
  const [lettaCodeError, setLettaCodeError] = useState<string | null>(null);
  const [lettaCodeLoaded, setLettaCodeLoaded] = useState(false);
  const [lettaCodeQuery, setLettaCodeQuery] = useState<string>(""); // Query used to load current data

  // All tab state (cached separately)
  const [allAgents, setAllAgents] = useState<AgentState[]>([]);
  const [allCursor, setAllCursor] = useState<string | null>(null);
  const [allLoading, setAllLoading] = useState(false);
  const [allLoadingMore, setAllLoadingMore] = useState(false);
  const [allHasMore, setAllHasMore] = useState(true);
  const [allSelectedIndex, setAllSelectedIndex] = useState(0);
  const [allPage, setAllPage] = useState(0);
  const [allError, setAllError] = useState<string | null>(null);
  const [allLoaded, setAllLoaded] = useState(false);
  const [allQuery, setAllQuery] = useState<string>(""); // Query used to load current data

  // Search state (shared across list tabs)
  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  // Load pinned agents
  const loadPinnedAgents = useCallback(async () => {
    setPinnedLoading(true);
    try {
      const mergedPinned = settingsManager.getMergedPinnedAgents();

      if (mergedPinned.length === 0) {
        setPinnedAgents([]);
        setPinnedLoading(false);
        return;
      }

      const client = clientRef.current || (await getClient());
      clientRef.current = client;

      const pinnedData = await Promise.all(
        mergedPinned.map(async ({ agentId, isLocal }) => {
          try {
            const agent = await client.agents.retrieve(agentId, {
              include: ["agent.blocks"],
            });
            return { agentId, agent, error: null, isLocal };
          } catch {
            return { agentId, agent: null, error: "Agent not found", isLocal };
          }
        }),
      );

      setPinnedAgents(pinnedData);
    } catch {
      setPinnedAgents([]);
    } finally {
      setPinnedLoading(false);
    }
  }, []);

  // Fetch agents for list tabs (Letta Code / All)
  const fetchListAgents = useCallback(
    async (
      filterLettaCode: boolean,
      afterCursor?: string | null,
      query?: string,
    ) => {
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

      const cursor =
        agentList.items.length === FETCH_PAGE_SIZE
          ? (agentList.items[agentList.items.length - 1]?.id ?? null)
          : null;

      return { agents: agentList.items, nextCursor: cursor };
    },
    [],
  );

  // Load Letta Code agents
  const loadLettaCodeAgents = useCallback(
    async (query?: string) => {
      setLettaCodeLoading(true);
      setLettaCodeError(null);
      try {
        const result = await fetchListAgents(true, null, query);
        setLettaCodeAgents(result.agents);
        setLettaCodeCursor(result.nextCursor);
        setLettaCodeHasMore(result.nextCursor !== null);
        setLettaCodePage(0);
        setLettaCodeSelectedIndex(0);
        setLettaCodeLoaded(true);
        setLettaCodeQuery(query || ""); // Track query used for this load
      } catch (err) {
        setLettaCodeError(err instanceof Error ? err.message : String(err));
      } finally {
        setLettaCodeLoading(false);
      }
    },
    [fetchListAgents],
  );

  // Load All agents
  const loadAllAgents = useCallback(
    async (query?: string) => {
      setAllLoading(true);
      setAllError(null);
      try {
        const result = await fetchListAgents(false, null, query);
        setAllAgents(result.agents);
        setAllCursor(result.nextCursor);
        setAllHasMore(result.nextCursor !== null);
        setAllPage(0);
        setAllSelectedIndex(0);
        setAllLoaded(true);
        setAllQuery(query || ""); // Track query used for this load
      } catch (err) {
        setAllError(err instanceof Error ? err.message : String(err));
      } finally {
        setAllLoading(false);
      }
    },
    [fetchListAgents],
  );

  // Load pinned agents on mount
  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

  // Load tab data when switching tabs (only if not already loaded)
  useEffect(() => {
    if (activeTab === "letta-code" && !lettaCodeLoaded && !lettaCodeLoading) {
      loadLettaCodeAgents();
    } else if (activeTab === "all" && !allLoaded && !allLoading) {
      loadAllAgents();
    }
  }, [
    activeTab,
    lettaCodeLoaded,
    lettaCodeLoading,
    loadLettaCodeAgents,
    allLoaded,
    allLoading,
    loadAllAgents,
  ]);

  // Reload current tab when search query changes (only if query differs from cached)
  useEffect(() => {
    if (activeTab === "letta-code" && activeQuery !== lettaCodeQuery) {
      loadLettaCodeAgents(activeQuery || undefined);
    } else if (activeTab === "all" && activeQuery !== allQuery) {
      loadAllAgents(activeQuery || undefined);
    }
  }, [
    activeQuery,
    activeTab,
    lettaCodeQuery,
    allQuery,
    loadLettaCodeAgents,
    loadAllAgents,
  ]);

  // Fetch more Letta Code agents
  const fetchMoreLettaCodeAgents = useCallback(async () => {
    if (lettaCodeLoadingMore || !lettaCodeHasMore || !lettaCodeCursor) return;

    setLettaCodeLoadingMore(true);
    try {
      const result = await fetchListAgents(
        true,
        lettaCodeCursor,
        activeQuery || undefined,
      );
      setLettaCodeAgents((prev) => [...prev, ...result.agents]);
      setLettaCodeCursor(result.nextCursor);
      setLettaCodeHasMore(result.nextCursor !== null);
    } catch {
      // Silently fail on pagination errors
    } finally {
      setLettaCodeLoadingMore(false);
    }
  }, [
    lettaCodeLoadingMore,
    lettaCodeHasMore,
    lettaCodeCursor,
    fetchListAgents,
    activeQuery,
  ]);

  // Fetch more All agents
  const fetchMoreAllAgents = useCallback(async () => {
    if (allLoadingMore || !allHasMore || !allCursor) return;

    setAllLoadingMore(true);
    try {
      const result = await fetchListAgents(
        false,
        allCursor,
        activeQuery || undefined,
      );
      setAllAgents((prev) => [...prev, ...result.agents]);
      setAllCursor(result.nextCursor);
      setAllHasMore(result.nextCursor !== null);
    } catch {
      // Silently fail on pagination errors
    } finally {
      setAllLoadingMore(false);
    }
  }, [allLoadingMore, allHasMore, allCursor, fetchListAgents, activeQuery]);

  // Pagination calculations - Pinned
  const pinnedTotalPages = Math.ceil(pinnedAgents.length / DISPLAY_PAGE_SIZE);
  const pinnedStartIndex = pinnedPage * DISPLAY_PAGE_SIZE;
  const pinnedPageAgents = pinnedAgents.slice(
    pinnedStartIndex,
    pinnedStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Pagination calculations - Letta Code
  const lettaCodeTotalPages = Math.ceil(
    lettaCodeAgents.length / DISPLAY_PAGE_SIZE,
  );
  const lettaCodeStartIndex = lettaCodePage * DISPLAY_PAGE_SIZE;
  const lettaCodePageAgents = lettaCodeAgents.slice(
    lettaCodeStartIndex,
    lettaCodeStartIndex + DISPLAY_PAGE_SIZE,
  );
  const lettaCodeCanGoNext =
    lettaCodePage < lettaCodeTotalPages - 1 || lettaCodeHasMore;

  // Pagination calculations - All
  const allTotalPages = Math.ceil(allAgents.length / DISPLAY_PAGE_SIZE);
  const allStartIndex = allPage * DISPLAY_PAGE_SIZE;
  const allPageAgents = allAgents.slice(
    allStartIndex,
    allStartIndex + DISPLAY_PAGE_SIZE,
  );
  const allCanGoNext = allPage < allTotalPages - 1 || allHasMore;

  // Current tab's state (computed)
  const currentLoading =
    activeTab === "pinned"
      ? pinnedLoading
      : activeTab === "letta-code"
        ? lettaCodeLoading
        : allLoading;
  const currentError =
    activeTab === "letta-code"
      ? lettaCodeError
      : activeTab === "all"
        ? allError
        : null;
  const currentAgents =
    activeTab === "pinned"
      ? pinnedPageAgents.map((p) => p.agent).filter(Boolean)
      : activeTab === "letta-code"
        ? lettaCodePageAgents
        : allPageAgents;
  const setCurrentSelectedIndex =
    activeTab === "pinned"
      ? setPinnedSelectedIndex
      : activeTab === "letta-code"
        ? setLettaCodeSelectedIndex
        : setAllSelectedIndex;

  // Submit search
  const submitSearch = useCallback(() => {
    if (searchInput !== activeQuery) {
      setActiveQuery(searchInput);
    }
  }, [searchInput, activeQuery]);

  // Clear search (effect will handle reload when query changes)
  const clearSearch = useCallback(() => {
    setSearchInput("");
    if (activeQuery) {
      setActiveQuery("");
    }
  }, [activeQuery]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    // Tab key cycles through tabs
    if (key.tab) {
      const currentIndex = TABS.findIndex((t) => t.id === activeTab);
      const nextIndex = (currentIndex + 1) % TABS.length;
      setActiveTab(TABS[nextIndex]?.id ?? "pinned");
      return;
    }

    if (currentLoading) return;

    // For pinned tab, use pinnedPageAgents.length to include "not found" entries
    // For other tabs, use currentAgents.length
    const maxIndex =
      activeTab === "pinned"
        ? pinnedPageAgents.length - 1
        : (currentAgents as AgentState[]).length - 1;

    if (key.upArrow) {
      setCurrentSelectedIndex((prev: number) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setCurrentSelectedIndex((prev: number) => Math.min(maxIndex, prev + 1));
    } else if (key.return) {
      // If typing a search query (list tabs only), submit it
      if (
        activeTab !== "pinned" &&
        searchInput &&
        searchInput !== activeQuery
      ) {
        submitSearch();
        return;
      }

      // Select agent
      if (activeTab === "pinned") {
        const selected = pinnedPageAgents[pinnedSelectedIndex];
        if (selected?.agent) {
          onSelect(selected.agentId);
        }
      } else if (activeTab === "letta-code") {
        const selected = lettaCodePageAgents[lettaCodeSelectedIndex];
        if (selected?.id) {
          onSelect(selected.id);
        }
      } else {
        const selected = allPageAgents[allSelectedIndex];
        if (selected?.id) {
          onSelect(selected.id);
        }
      }
    } else if (key.escape) {
      // If typing search (list tabs), clear it first
      if (activeTab !== "pinned" && searchInput) {
        clearSearch();
        return;
      }
      onCancel();
    } else if (key.backspace || key.delete) {
      if (activeTab !== "pinned") {
        setSearchInput((prev) => prev.slice(0, -1));
      }
    } else if (key.leftArrow) {
      // Previous page
      if (activeTab === "pinned") {
        if (pinnedPage > 0) {
          setPinnedPage((prev) => prev - 1);
          setPinnedSelectedIndex(0);
        }
      } else if (activeTab === "letta-code") {
        if (lettaCodePage > 0) {
          setLettaCodePage((prev) => prev - 1);
          setLettaCodeSelectedIndex(0);
        }
      } else {
        if (allPage > 0) {
          setAllPage((prev) => prev - 1);
          setAllSelectedIndex(0);
        }
      }
    } else if (key.rightArrow) {
      // Next page
      if (activeTab === "pinned") {
        if (pinnedPage < pinnedTotalPages - 1) {
          setPinnedPage((prev) => prev + 1);
          setPinnedSelectedIndex(0);
        }
      } else if (activeTab === "letta-code" && lettaCodeCanGoNext) {
        const nextPageIndex = lettaCodePage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= lettaCodeAgents.length && lettaCodeHasMore) {
          fetchMoreLettaCodeAgents();
        }

        if (nextStartIndex < lettaCodeAgents.length) {
          setLettaCodePage(nextPageIndex);
          setLettaCodeSelectedIndex(0);
        }
      } else if (activeTab === "all" && allCanGoNext) {
        const nextPageIndex = allPage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= allAgents.length && allHasMore) {
          fetchMoreAllAgents();
        }

        if (nextStartIndex < allAgents.length) {
          setAllPage(nextPageIndex);
          setAllSelectedIndex(0);
        }
      }
      // NOTE: "D" for unpin all disabled - too destructive without confirmation
      // } else if (activeTab === "pinned" && (input === "d" || input === "D")) {
      //   const selected = pinnedPageAgents[pinnedSelectedIndex];
      //   if (selected) {
      //     settingsManager.unpinBoth(selected.agentId);
      //     loadPinnedAgents();
      //   }
      // }
    } else if (activeTab === "pinned" && (input === "p" || input === "P")) {
      // Unpin from current scope (pinned tab only)
      const selected = pinnedPageAgents[pinnedSelectedIndex];
      if (selected) {
        if (selected.isLocal) {
          settingsManager.unpinLocal(selected.agentId);
        } else {
          settingsManager.unpinGlobal(selected.agentId);
        }
        loadPinnedAgents();
      }
    } else if (input === "n" || input === "N") {
      // Create new agent
      onCreateNewAgent?.();
    } else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {
      // Type to search (list tabs only)
      setSearchInput((prev) => prev + input);
    }
  });

  // Render tab bar
  const renderTabBar = () => (
    <Box flexDirection="row" gap={2}>
      {TABS.map((tab) => {
        const isActive = tab.id === activeTab;
        // Always use same width (with padding) to prevent jitter when switching tabs
        return (
          <Text
            key={tab.id}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "black" : undefined}
            bold={isActive}
          >
            {` ${tab.label} `}
          </Text>
        );
      })}
    </Box>
  );

  // Render agent item (shared between tabs)
  const renderAgentItem = (
    agent: AgentState,
    _index: number,
    isSelected: boolean,
    extra?: { isLocal?: boolean },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCount = agent.blocks?.length ?? 0;
    const modelStr = formatModel(agent);

    const nameLen = (agent.name || "Unnamed").length;
    const fixedChars = 2 + 3 + (isCurrent ? 10 : 0);
    const availableForId = Math.max(15, terminalWidth - nameLen - fixedChars);
    const displayId = truncateAgentId(agent.id, availableForId);

    return (
      <Box key={agent.id} flexDirection="column" marginBottom={1}>
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
            {agent.name || "Unnamed"}
          </Text>
          <Text dimColor>
            {" · "}
            {extra?.isLocal !== undefined
              ? `${extra.isLocal ? "project" : "global"} · `
              : ""}
            {displayId}
          </Text>
          {isCurrent && (
            <Text color={colors.selector.itemCurrent}> (current)</Text>
          )}
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor italic>
            {agent.description || "No description"}
          </Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text dimColor>
            {relativeTime} · {blockCount} memory block
            {blockCount === 1 ? "" : "s"} · {modelStr}
          </Text>
        </Box>
      </Box>
    );
  };

  // Render pinned agent item (may have error)
  const renderPinnedItem = (
    data: PinnedAgentData,
    index: number,
    isSelected: boolean,
  ) => {
    if (data.agent) {
      return renderAgentItem(data.agent, index, isSelected, {
        isLocal: data.isLocal,
      });
    }

    // Error state for missing agent
    return (
      <Box key={data.agentId} flexDirection="column" marginBottom={1}>
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
            {data.agentId.slice(0, 12)}
          </Text>
          <Text dimColor> · {data.isLocal ? "project" : "global"}</Text>
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text color="red" italic>
            {data.error}
          </Text>
        </Box>
      </Box>
    );
  };

  // Calculate horizontal line width
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{`> ${command}`}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Header */}
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Swap to a different agent
        </Text>
        <Box flexDirection="column" paddingLeft={1}>
          {renderTabBar()}
          <Text dimColor> {TAB_DESCRIPTIONS[activeTab]}</Text>
        </Box>
      </Box>

      {/* Search input - list tabs only */}
      {activeTab !== "pinned" && (searchInput || activeQuery) && (
        <Box marginBottom={1}>
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

      {/* Error state - list tabs */}
      {activeTab !== "pinned" && currentError && (
        <Box flexDirection="column">
          <Text color="red">Error: {currentError}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {/* Loading state */}
      {currentLoading && (
        <Box>
          <Text dimColor>{"  "}Loading agents...</Text>
        </Box>
      )}

      {/* Empty state */}
      {!currentLoading &&
        ((activeTab === "pinned" && pinnedAgents.length === 0) ||
          (activeTab === "letta-code" &&
            !lettaCodeError &&
            lettaCodeAgents.length === 0) ||
          (activeTab === "all" && !allError && allAgents.length === 0)) && (
          <Box flexDirection="column">
            <Text dimColor>{TAB_EMPTY_STATES[activeTab]}</Text>
            <Text dimColor>Press ESC to cancel</Text>
          </Box>
        )}

      {/* Pinned tab content */}
      {activeTab === "pinned" && !pinnedLoading && pinnedAgents.length > 0 && (
        <Box flexDirection="column">
          {pinnedPageAgents.map((data, index) =>
            renderPinnedItem(data, index, index === pinnedSelectedIndex),
          )}
        </Box>
      )}

      {/* Letta Code tab content */}
      {activeTab === "letta-code" &&
        !lettaCodeLoading &&
        !lettaCodeError &&
        lettaCodeAgents.length > 0 && (
          <Box flexDirection="column">
            {lettaCodePageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === lettaCodeSelectedIndex),
            )}
          </Box>
        )}

      {/* All tab content */}
      {activeTab === "all" &&
        !allLoading &&
        !allError &&
        allAgents.length > 0 && (
          <Box flexDirection="column">
            {allPageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === allSelectedIndex),
            )}
          </Box>
        )}

      {/* Footer */}
      {!currentLoading &&
        ((activeTab === "pinned" && pinnedAgents.length > 0) ||
          (activeTab === "letta-code" &&
            !lettaCodeError &&
            lettaCodeAgents.length > 0) ||
          (activeTab === "all" && !allError && allAgents.length > 0)) &&
        (() => {
          const footerWidth = Math.max(0, terminalWidth - 2);
          const pageText =
            activeTab === "pinned"
              ? `Page ${pinnedPage + 1}/${pinnedTotalPages || 1}`
              : activeTab === "letta-code"
                ? `Page ${lettaCodePage + 1}${lettaCodeHasMore ? "+" : `/${lettaCodeTotalPages || 1}`}${lettaCodeLoadingMore ? " (loading...)" : ""}`
                : `Page ${allPage + 1}${allHasMore ? "+" : `/${allTotalPages || 1}`}${allLoadingMore ? " (loading...)" : ""}`;
          const hintsText = `Enter select · ↑↓ navigate · ←→ page · Tab switch${activeTab === "pinned" ? " · P unpin" : " · Type to search"}${onCreateNewAgent ? " · N new" : ""} · Esc cancel`;

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
