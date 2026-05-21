import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useState } from "react";
import { getModelDisplayName } from "@/agent/model";
import {
  type Backend,
  getApiBackendInstance,
  getLocalBackendInstance,
  isLocalBackendEnabled,
} from "@/backend";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { settingsManager } from "@/settings-manager";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string) => void;
  onCancel: () => void;
  /** Called when user creates a new agent (from New tab or N shortcut) */
  onCreateNewAgent?: (name: string) => void;
  /** The command that triggered this selector (e.g., "/agents" or "/resume") */
  command?: string;
}

type TabId = "pinned" | "letta-code" | "local" | "all" | "new";

type ViewState =
  | { type: "list" }
  | { type: "deleteConfirm"; agent: AgentState; agentId: string };

interface PinnedAgentData {
  agentId: string;
  agent: AgentState | null;
  error: string | null;
  isLocal: boolean;
}

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "letta-code", label: "Letta Code" },
  { id: "local", label: "Local" },
  { id: "all", label: "All" },
  { id: "new", label: "New" },
];

const TAB_DESCRIPTIONS: Record<TabId, string> = {
  pinned: "Save agents for easy access by pinning them with /pin",
  "letta-code": "Displaying agents created inside of Letta Code",
  local: "Agents stored on this device",
  all: "Displaying all available agents",
  new: "Create a brand new agent",
};

const TAB_EMPTY_STATES: Record<TabId, string> = {
  pinned: "No pinned agents, use /pin to save",
  "letta-code": "No agents with tag 'origin:letta-code'",
  local: "No local agents found",
  all: "No agents found",
  new: "",
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

  // Per-backend instances for listing — independent of the app-level active backend.
  // Cloud tabs always use the API backend; Local tab always uses the local backend.
  const getCloudBackend = useCallback((): Backend => {
    return getApiBackendInstance();
  }, []);

  const getLocalBackend = useCallback((): Backend => {
    return getLocalBackendInstance();
  }, []);

  // Whether the user has cloud credentials (gates cloud tab content).
  // Check env vars, settings env block, and the secure token cache (keychain).
  const hasCloudCredentials = Boolean(
    process.env.LETTA_API_KEY ||
      settingsManager.getSettings().env?.LETTA_API_KEY ||
      settingsManager.getCachedSecureTokens().apiKey ||
      settingsManager.getCachedSecureTokens().refreshToken,
  );

  // Local tab state — loaded eagerly at mount to decide whether to show the tab
  const [localAgents, setLocalAgents] = useState<AgentState[]>([]);
  const [localHasMore, setLocalHasMore] = useState(true);
  const [localLoading, setLocalLoading] = useState(true);
  const [localSelectedIndex, setLocalSelectedIndex] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const [localError, setLocalError] = useState<string | null>(null);
  const [hasLocalAgents, setHasLocalAgents] = useState(false);

  // Tab state — start at Pinned, jump to Local once agents are confirmed to exist
  const [activeTab, setActiveTab] = useState<TabId>("pinned");

  useEffect(() => {
    if (isLocalBackendEnabled() && hasLocalAgents && activeTab === "pinned") {
      setActiveTab("local");
    }
  }, [hasLocalAgents, activeTab]);

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

  // Delete confirmation state
  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  // New agent tab state
  const [newAgentNameInput, setNewAgentNameInput] = useState("");
  const [newAgentNameError, setNewAgentNameError] = useState("");

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

      const cachedTokens = settingsManager.getCachedSecureTokens();
      const cloudCredentialsAvailable = Boolean(
        process.env.LETTA_API_KEY ||
          settingsManager.getSettings().env?.LETTA_API_KEY ||
          cachedTokens.apiKey ||
          cachedTokens.refreshToken,
      );

      const pinnedData = await Promise.all(
        mergedPinned.map(async ({ agentId, isLocal }) => {
          // Skip cloud fetches when not authenticated — cloud backend would throw
          if (!isLocal && !cloudCredentialsAvailable) {
            return { agentId, agent: null, error: "Not connected", isLocal };
          }
          try {
            // Route each pinned agent to its own backend
            const agentBackend = isLocal
              ? getLocalBackend()
              : getCloudBackend();
            const agent = await agentBackend.retrieveAgent(agentId, {
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
  }, [getCloudBackend, getLocalBackend]);

  // Fetch agents for list tabs (Letta Code / All / Local)
  const fetchListAgents = useCallback(
    async (
      backend: Backend,
      filterLettaCode: boolean,
      afterCursor?: string | null,
      query?: string,
    ) => {
      const agentList = await backend.listAgents({
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

  // Load local agents (always from local backend)
  const loadLocalAgents = useCallback(async () => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const result = await fetchListAgents(getLocalBackend(), false, null);
      setLocalAgents(result.agents);
      setLocalHasMore(result.nextCursor !== null);
      setLocalPage(0);
      setLocalSelectedIndex(0);
      setHasLocalAgents(result.agents.length > 0);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : String(err));
    } finally {
      setLocalLoading(false);
    }
  }, [fetchListAgents, getLocalBackend]);

  // Load Letta Code agents
  const loadLettaCodeAgents = useCallback(
    async (query?: string) => {
      setLettaCodeLoading(true);
      setLettaCodeError(null);
      try {
        const result = await fetchListAgents(
          getCloudBackend(),
          true,
          null,
          query,
        );
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
    [fetchListAgents, getCloudBackend],
  );

  // Load All agents
  const loadAllAgents = useCallback(
    async (query?: string) => {
      setAllLoading(true);
      setAllError(null);
      try {
        const result = await fetchListAgents(
          getCloudBackend(),
          false,
          null,
          query,
        );
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
    [fetchListAgents, getCloudBackend],
  );

  // Load pinned agents on mount
  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

  // Load local agents eagerly at mount (needed to decide whether to show the tab)
  useEffect(() => {
    loadLocalAgents();
  }, [loadLocalAgents]);

  // Load tab data when switching tabs (only if not already loaded).
  // Skip cloud tabs entirely when no credentials — cloud backend would throw.
  useEffect(() => {
    if (!hasCloudCredentials) return;
    if (activeTab === "letta-code" && !lettaCodeLoaded && !lettaCodeLoading) {
      loadLettaCodeAgents();
    } else if (activeTab === "all" && !allLoaded && !allLoading) {
      loadAllAgents();
    }
  }, [
    hasCloudCredentials,
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
    if (!hasCloudCredentials) return;
    if (activeTab === "letta-code" && activeQuery !== lettaCodeQuery) {
      loadLettaCodeAgents(activeQuery || undefined);
    } else if (activeTab === "all" && activeQuery !== allQuery) {
      loadAllAgents(activeQuery || undefined);
    }
  }, [
    hasCloudCredentials,
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
        getCloudBackend(),
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
    getCloudBackend,
  ]);

  // Fetch more All agents
  const fetchMoreAllAgents = useCallback(async () => {
    if (allLoadingMore || !allHasMore || !allCursor) return;

    setAllLoadingMore(true);
    try {
      const result = await fetchListAgents(
        getCloudBackend(),
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
  }, [
    allLoadingMore,
    allHasMore,
    allCursor,
    fetchListAgents,
    activeQuery,
    getCloudBackend,
  ]);

  // Pagination calculations - Pinned (filter out 404 agents)
  const validPinnedAgents = pinnedAgents.filter((p) => p.agent !== null);
  const pinnedTotalPages = Math.ceil(
    validPinnedAgents.length / DISPLAY_PAGE_SIZE,
  );
  const pinnedStartIndex = pinnedPage * DISPLAY_PAGE_SIZE;
  const pinnedPageAgents = validPinnedAgents.slice(
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

  // Pagination calculations - Local
  const localTotalPages = Math.ceil(localAgents.length / DISPLAY_PAGE_SIZE);
  const localStartIndex = localPage * DISPLAY_PAGE_SIZE;
  const localPageAgents = localAgents.slice(
    localStartIndex,
    localStartIndex + DISPLAY_PAGE_SIZE,
  );
  const localCanGoNext = localPage < localTotalPages - 1 || localHasMore;

  // Pagination calculations - All
  const allTotalPages = Math.ceil(allAgents.length / DISPLAY_PAGE_SIZE);
  const allStartIndex = allPage * DISPLAY_PAGE_SIZE;
  const allPageAgents = allAgents.slice(
    allStartIndex,
    allStartIndex + DISPLAY_PAGE_SIZE,
  );
  const allCanGoNext = allPage < allTotalPages - 1 || allHasMore;

  // Visible tabs — Local tab only shown when local agents exist
  const visibleTabs = ALL_TABS.filter(
    (t) => t.id !== "local" || hasLocalAgents,
  );

  // Current tab's state (computed)
  const currentLoading =
    activeTab === "pinned"
      ? pinnedLoading
      : activeTab === "letta-code"
        ? lettaCodeLoading
        : activeTab === "local"
          ? localLoading
          : allLoading;
  const currentError =
    activeTab === "letta-code"
      ? lettaCodeError
      : activeTab === "local"
        ? localError
        : activeTab === "all"
          ? allError
          : null;
  const currentAgents =
    activeTab === "pinned"
      ? pinnedPageAgents.map((p) => p.agent).filter(Boolean)
      : activeTab === "letta-code"
        ? lettaCodePageAgents
        : activeTab === "local"
          ? localPageAgents
          : allPageAgents;
  const setCurrentSelectedIndex =
    activeTab === "pinned"
      ? setPinnedSelectedIndex
      : activeTab === "letta-code"
        ? setLettaCodeSelectedIndex
        : activeTab === "local"
          ? setLocalSelectedIndex
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

  // Handle agent deletion
  const handleDeleteAgent = useCallback(async () => {
    if (viewState.type !== "deleteConfirm") return;
    const { agent, agentId } = viewState;
    const expectedName = agent.name || agentId.slice(0, 12);

    if (deleteConfirmInput !== expectedName) return;

    setDeleteLoading(true);
    try {
      // Route delete to the correct backend by agent ID prefix
      const agentBackend = agentId.startsWith("agent-local-")
        ? getLocalBackend()
        : getCloudBackend();
      await agentBackend.deleteAgent(agentId);

      // Reset state and refresh tabs
      setViewState({ type: "list" });
      setDeleteConfirmInput("");
      // Reload pinned and invalidate cached tabs
      loadPinnedAgents();
      setLettaCodeLoaded(false);
      setAllLoaded(false);
    } catch {
      // Stay on confirmation screen on error
    } finally {
      setDeleteLoading(false);
    }
  }, [
    viewState,
    deleteConfirmInput,
    loadPinnedAgents,
    getLocalBackend,
    getCloudBackend,
  ]);

  useInput((input, key) => {
    // CTRL-C: immediately cancel
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    // Handle delete confirmation view
    if (viewState.type === "deleteConfirm") {
      // Always allow Esc to back out (even during deletion)
      if (key.escape) {
        setViewState({ type: "list" });
        setDeleteConfirmInput("");
        return;
      }

      // Disable all other input while deleting
      if (deleteLoading) return;

      if (key.return) {
        handleDeleteAgent();
      } else if (key.backspace || key.delete) {
        setDeleteConfirmInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setDeleteConfirmInput((prev) => prev + input);
      }
      return;
    }

    // List view handlers below

    // Tab key cycles through visible tabs
    if (key.tab) {
      const currentIndex = visibleTabs.findIndex((t) => t.id === activeTab);
      const nextIndex = (currentIndex + 1) % visibleTabs.length;
      setActiveTab(visibleTabs[nextIndex]?.id ?? "pinned");
      return;
    }

    if (currentLoading) return;

    // New tab has its own input handling via PasteAwareTextInput.
    // Only handle Escape here.
    if (activeTab === "new") {
      if (key.escape) {
        if (newAgentNameInput) {
          setNewAgentNameInput("");
          setNewAgentNameError("");
        } else {
          onCancel();
        }
      }
      return;
    }

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
      } else if (activeTab === "local") {
        const selected = localPageAgents[localSelectedIndex];
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
      // If typing search (cloud list tabs), clear it first
      if (activeTab !== "pinned" && activeTab !== "local" && searchInput) {
        clearSearch();
        return;
      }
      onCancel();
    } else if (key.backspace || key.delete) {
      if (activeTab !== "pinned" && activeTab !== "local") {
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
      } else if (activeTab === "local") {
        if (localPage > 0) {
          setLocalPage((prev) => prev - 1);
          setLocalSelectedIndex(0);
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
      } else if (activeTab === "local" && localCanGoNext) {
        const nextPageIndex = localPage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= localAgents.length && localHasMore) {
          // Local backend doesn't paginate the same way — just advance page
        }

        if (nextStartIndex < localAgents.length) {
          setLocalPage(nextPageIndex);
          setLocalSelectedIndex(0);
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
    } else if (input === "D") {
      // Delete agent - open confirmation
      let selectedAgent: AgentState | null = null;
      let selectedAgentId: string | null = null;

      if (activeTab === "pinned") {
        const selected = pinnedPageAgents[pinnedSelectedIndex];
        if (selected?.agent) {
          selectedAgent = selected.agent;
          selectedAgentId = selected.agentId;
        }
      } else if (activeTab === "letta-code") {
        selectedAgent = lettaCodePageAgents[lettaCodeSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
      } else if (activeTab === "local") {
        selectedAgent = localPageAgents[localSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
      } else {
        selectedAgent = allPageAgents[allSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
      }

      if (selectedAgent && selectedAgentId) {
        setViewState({
          type: "deleteConfirm",
          agent: selectedAgent,
          agentId: selectedAgentId,
        });
        setDeleteConfirmInput("");
      }
    } else if (input === "n" || input === "N") {
      // Switch to New tab
      setActiveTab("new");
    } else if (
      activeTab !== "pinned" &&
      activeTab !== "local" &&
      input &&
      !key.ctrl &&
      !key.meta
    ) {
      // Type to search (cloud list tabs only — local has no search)
      setSearchInput((prev) => prev + input);
    }
  });

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

  // Render delete confirmation view
  const renderDeleteConfirm = () => {
    if (viewState.type !== "deleteConfirm") return null;
    const { agent, agentId } = viewState;
    const displayName = agent.name || agentId.slice(0, 12);
    const inputMatches = deleteConfirmInput === displayName;

    return (
      <>
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {"  "}Are you sure you want to delete{" "}
            <Text bold>{displayName}</Text>?
          </Text>
          <Text color="red">{"  "}This action can not be undone.</Text>
        </Box>

        <Box flexDirection="row">
          <Text color={colors.selector.itemHighlighted}>{"> "}</Text>
          <Text dimColor={!deleteConfirmInput}>
            {deleteConfirmInput || "(type the agent's name)"}
          </Text>
        </Box>

        <Box marginTop={1}>
          <Text dimColor>
            {"  "}
            {deleteLoading
              ? "Deleting... · Esc cancel"
              : inputMatches
                ? "Enter to delete · Esc cancel"
                : "Esc cancel"}
          </Text>
        </Box>
      </>
    );
  };

  // If in delete confirmation view, render that instead of the list
  if (viewState.type === "deleteConfirm") {
    return (
      <OverlayShell command={command} title="Delete agent">
        {renderDeleteConfirm()}
      </OverlayShell>
    );
  }

  return (
    <OverlayShell
      command={command}
      title="Swap to a different agent"
      footer={
        activeTab !== "new" &&
        !currentLoading &&
        ((activeTab === "pinned" && validPinnedAgents.length > 0) ||
          (activeTab === "letta-code" &&
            !lettaCodeError &&
            lettaCodeAgents.length > 0) ||
          (activeTab === "local" && !localError && localAgents.length > 0) ||
          (activeTab === "all" && !allError && allAgents.length > 0))
          ? (() => {
              const footerWidth = Math.max(0, terminalWidth - 2);
              const pageText =
                activeTab === "pinned"
                  ? `Page ${pinnedPage + 1}/${pinnedTotalPages || 1}`
                  : activeTab === "letta-code"
                    ? `Page ${lettaCodePage + 1}${lettaCodeHasMore ? "+" : `/${lettaCodeTotalPages || 1}`}${lettaCodeLoadingMore ? " (loading...)" : ""}`
                    : activeTab === "local"
                      ? `Page ${localPage + 1}/${localTotalPages || 1}`
                      : `Page ${allPage + 1}${allHasMore ? "+" : `/${allTotalPages || 1}`}${allLoadingMore ? " (loading...)" : ""}`;
              const hintsText = `Enter select · ↑↓ ←→ navigate · Tab switch · Shift+D delete${activeTab === "pinned" ? " · P unpin" : ""} · Esc cancel`;

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
            })()
          : undefined
      }
    >
      <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
        <TabBar
          tabs={visibleTabs.map((t) => t.id)}
          activeTab={activeTab}
          getLabel={(tabId) =>
            visibleTabs.find((t) => t.id === tabId)?.label ?? tabId
          }
        />
        <Text dimColor> {TAB_DESCRIPTIONS[activeTab]}</Text>
      </Box>

      {/* No cloud credentials message for cloud tabs */}
      {!hasCloudCredentials &&
        (activeTab === "pinned" ||
          activeTab === "letta-code" ||
          activeTab === "all") && (
          <Box flexDirection="column" paddingLeft={2}>
            <Text dimColor>Connect to Letta Cloud to see agents here.</Text>
            <Text dimColor>Run /login to sign in.</Text>
          </Box>
        )}

      {/* Search input - list tabs only (not local — local has no search yet) */}
      {activeTab !== "pinned" &&
        activeTab !== "local" &&
        (searchInput || activeQuery) && (
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
      {activeTab !== "pinned" && activeTab !== "local" && currentError && (
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
        ((activeTab === "pinned" &&
          hasCloudCredentials &&
          validPinnedAgents.length === 0) ||
          (activeTab === "letta-code" &&
            hasCloudCredentials &&
            !lettaCodeError &&
            lettaCodeAgents.length === 0) ||
          (activeTab === "local" && !localError && localAgents.length === 0) ||
          (activeTab === "all" &&
            hasCloudCredentials &&
            !allError &&
            allAgents.length === 0)) && (
          <Box flexDirection="column">
            <Text dimColor>{TAB_EMPTY_STATES[activeTab]}</Text>
            <Text dimColor>Press ESC to cancel</Text>
          </Box>
        )}

      {/* Pinned tab content */}
      {activeTab === "pinned" &&
        !pinnedLoading &&
        validPinnedAgents.length > 0 && (
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

      {/* Local tab content */}
      {activeTab === "local" &&
        !localLoading &&
        !localError &&
        localAgents.length > 0 && (
          <Box flexDirection="column">
            {localPageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === localSelectedIndex),
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

      {/* New tab content */}
      {activeTab === "new" && (
        <Box flexDirection="column">
          <Box height={1} />
          <Box paddingLeft={2}>
            <Text>
              Enter a name for your new agent, or press Enter for default.
            </Text>
          </Box>
          <Box height={1} />
          <Box flexDirection="column">
            <Box paddingLeft={2}>
              <Text>Agent name:</Text>
            </Box>
            <Box>
              <Text color={colors.selector.itemHighlighted}>{">"}</Text>
              <Text> </Text>
              <PasteAwareTextInput
                value={newAgentNameInput}
                onChange={(val) => {
                  setNewAgentNameInput(val);
                  setNewAgentNameError("");
                }}
                onSubmit={(text) => {
                  const trimmed = text.trim();
                  if (!trimmed) {
                    onCreateNewAgent?.(DEFAULT_AGENT_NAME);
                    return;
                  }
                  const validationError = validateAgentName(trimmed);
                  if (validationError) {
                    setNewAgentNameError(validationError);
                    return;
                  }
                  onCreateNewAgent?.(trimmed);
                }}
                placeholder={DEFAULT_AGENT_NAME}
              />
            </Box>
          </Box>
          {newAgentNameError && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color="red">{newAgentNameError}</Text>
            </Box>
          )}
          <Box height={1} />
          <Box paddingLeft={2}>
            <Text dimColor>Enter create · Esc cancel</Text>
          </Box>
        </Box>
      )}
    </OverlayShell>
  );
}
