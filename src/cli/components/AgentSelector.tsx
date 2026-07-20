import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { getModelDisplayName } from "@/agent/model";
import { getBackendForMode } from "@/backend/backend";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import {
  hasCloudCredentials,
  listPinnedAgentsForCurrentUser,
  type PinnedAgentData,
} from "@/cli/helpers/pinned-agent-listing";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { colors } from "./colors";
import { MarkdownDisplay } from "./MarkdownDisplay";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string, backendMode: AgentBackendMode) => void;
  onCancel: () => void;
  onLogin?: () => void;
  /** Called when user creates a new agent (from New tab or N shortcut) */
  onCreateNewAgent?: (name: string, backendMode: AgentBackendMode) => void;
  /** The command that triggered this selector (e.g., "/agents" or "/resume") */
  command?: string;
  /** Override the overlay title. */
  title?: string;
  /** Whether to show the New tab and N shortcut. */
  showNewTab?: boolean;
  /** Whether Shift+D can delete agents from the selector. */
  allowDelete?: boolean;
  /** Whether Shift+P can unpin agents from the selector. */
  allowPinActions?: boolean;
}

type TabId = "pinned" | "local" | "cloud" | "new";

type ViewState =
  | { type: "list" }
  | {
      type: "deleteConfirm";
      agent: AgentState;
      agentId: string;
      isLocal: boolean;
    };

const ALL_TABS: { id: TabId; label: string }[] = [
  { id: "pinned", label: "Pinned" },
  { id: "cloud", label: "Cloud" },
  { id: "local", label: "Local" },
  { id: "new", label: "New" },
];

const TAB_DESCRIPTIONS: Record<TabId, string> = {
  pinned: "Save agents for easy access with /pin or Desktop favorites",
  local: "Local agents from this device",
  cloud: "Agents hosted in Letta Cloud",
  new: "Create a brand new agent",
};

const TAB_EMPTY_STATES: Record<TabId, string> = {
  pinned: "No pinned or favorite agents, use /pin to save",
  local: "No local agents found",
  cloud: "No agents found",
  new: "",
};

const DISPLAY_PAGE_SIZE = 5;
const FETCH_PAGE_SIZE = 20;
const NEW_AGENT_DEFAULT_BACKEND: AgentBackendMode = "api";

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
  onLogin,
  onCreateNewAgent,
  command = "/agents",
  title = "Swap to a different agent",
  showNewTab = true,
  allowDelete = true,
  allowPinActions = true,
}: AgentSelectorProps) {
  const terminalWidth = useTerminalWidth();

  // Tab state
  // Eagerly check for local agents (synchronous disk read) to determine tab visibility
  const [hasLocalAgents, setHasLocalAgents] = useState(() => {
    try {
      return listLocalAgentsFromDisk().length > 0;
    } catch {
      return false;
    }
  });

  // Compute visible tabs — Local tab only shown when there are local agents
  const visibleTabs = useMemo(
    () =>
      ALL_TABS.filter(
        (t) =>
          (showNewTab || t.id !== "new") &&
          (t.id !== "local" || hasLocalAgents),
      ),
    [hasLocalAgents, showNewTab],
  );

  const [activeTab, setActiveTab] = useState<TabId>("pinned");

  // If active tab is no longer visible (e.g. local tab hidden after deleting all local agents), fall back
  useEffect(() => {
    if (activeTab === "local" && !hasLocalAgents) {
      setActiveTab("cloud");
    } else if (activeTab === "new" && !showNewTab) {
      setActiveTab("pinned");
    }
  }, [activeTab, hasLocalAgents, showNewTab]);

  // Pinned tab state
  const [pinnedAgents, setPinnedAgents] = useState<PinnedAgentData[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedSelectedIndex, setPinnedSelectedIndex] = useState(0);
  const [pinnedPage, setPinnedPage] = useState(0);

  // Local tab state (reads from disk, no API calls)
  const [localAgents, setLocalAgents] = useState<AgentState[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localSelectedIndex, setLocalSelectedIndex] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const [localLoaded, setLocalLoaded] = useState(false);

  // Cloud tab state (fetches from API)
  const [cloudAgents, setCloudAgents] = useState<AgentState[]>([]);
  const [cloudCursor, setCloudCursor] = useState<string | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudLoadingMore, setCloudLoadingMore] = useState(false);
  const [cloudHasMore, setCloudHasMore] = useState(true);
  const [cloudSelectedIndex, setCloudSelectedIndex] = useState(0);
  const [cloudPage, setCloudPage] = useState(0);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [cloudQuery, setCloudQuery] = useState<string>("");
  const [hasCloudAuth, setHasCloudAuth] = useState<boolean | null>(null);

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
  const [newAgentBackendMode, setNewAgentBackendMode] =
    useState<AgentBackendMode>(NEW_AGENT_DEFAULT_BACKEND);

  // Load pinned agents
  const loadPinnedAgents = useCallback(async () => {
    setPinnedLoading(true);
    try {
      const pinnedData = await listPinnedAgentsForCurrentUser();
      const validPinnedData = pinnedData.filter((p) => p.agent !== null);

      if (validPinnedData.length === 0) {
        setPinnedAgents([]);
        setPinnedLoading(false);
        return;
      }

      setPinnedAgents(pinnedData);
    } catch {
      setPinnedAgents([]);
    } finally {
      setPinnedLoading(false);
    }
  }, []);

  // Load local agents from disk
  const loadLocalAgents = useCallback(() => {
    setLocalLoading(true);
    try {
      const agents = listLocalAgentsFromDisk();
      setLocalAgents(agents);
      setHasLocalAgents(agents.length > 0);
      setLocalPage(0);
      setLocalSelectedIndex(0);
      setLocalLoaded(true);
    } catch {
      setLocalAgents([]);
      setHasLocalAgents(false);
    } finally {
      setLocalLoading(false);
    }
  }, []);

  // Fetch Cloud agents from cloud API directly (not via getBackend, which may be local)
  const fetchCloudAgents = useCallback(
    async (afterCursor?: string | null, query?: string) => {
      const { getClient } = await import("@/backend/api/client");
      const client = await getClient();

      const agentList = await client.agents.list({
        limit: FETCH_PAGE_SIZE,
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

  // Load Cloud agents
  const loadCloudAgents = useCallback(
    async (query?: string) => {
      setCloudLoading(true);
      setCloudError(null);
      try {
        const result = await fetchCloudAgents(null, query);
        setCloudAgents(result.agents);
        setCloudCursor(result.nextCursor);
        setCloudHasMore(result.nextCursor !== null);
        setCloudPage(0);
        setCloudSelectedIndex(0);
        setCloudLoaded(true);
        setCloudQuery(query || "");
      } catch (err) {
        setCloudError(err instanceof Error ? err.message : String(err));
      } finally {
        setCloudLoading(false);
      }
    },
    [fetchCloudAgents],
  );

  // Fetch more Cloud agents (pagination)
  const fetchMoreCloudAgents = useCallback(async () => {
    if (cloudLoadingMore || !cloudHasMore || !cloudCursor) return;

    setCloudLoadingMore(true);
    try {
      const result = await fetchCloudAgents(
        cloudCursor,
        activeQuery || undefined,
      );
      setCloudAgents((prev) => [...prev, ...result.agents]);
      setCloudCursor(result.nextCursor);
      setCloudHasMore(result.nextCursor !== null);
    } catch {
      // Silently fail on pagination errors
    } finally {
      setCloudLoadingMore(false);
    }
  }, [
    cloudLoadingMore,
    cloudHasMore,
    cloudCursor,
    fetchCloudAgents,
    activeQuery,
  ]);

  // Check cloud credentials on mount (sync — reads from the in-memory keychain cache)
  useEffect(() => {
    setHasCloudAuth(hasCloudCredentials());
  }, []);

  // Load pinned agents on mount
  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

  // Load tab data when switching tabs (only if not already loaded)
  useEffect(() => {
    if (activeTab === "local" && !localLoaded && !localLoading) {
      loadLocalAgents();
    } else if (
      activeTab === "cloud" &&
      !cloudLoaded &&
      !cloudLoading &&
      hasCloudAuth
    ) {
      loadCloudAgents();
    }
  }, [
    activeTab,
    localLoaded,
    localLoading,
    loadLocalAgents,
    cloudLoaded,
    cloudLoading,
    loadCloudAgents,
    hasCloudAuth,
  ]);

  useEffect(() => {
    if (activeTab === "new") {
      setNewAgentBackendMode(NEW_AGENT_DEFAULT_BACKEND);
    }
  }, [activeTab]);

  // Reload current tab when search query changes (only if query differs from cached)
  useEffect(() => {
    if (activeTab === "cloud" && hasCloudAuth && activeQuery !== cloudQuery) {
      loadCloudAgents(activeQuery || undefined);
    }
  }, [activeQuery, activeTab, cloudQuery, loadCloudAgents, hasCloudAuth]);

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

  // Pagination calculations - Local (current agent pinned to top)
  const sortedLocalAgents = useMemo(
    () =>
      localAgents.toSorted((a, b) => {
        if (a.id === currentAgentId) return -1;
        if (b.id === currentAgentId) return 1;
        return 0;
      }),
    [localAgents, currentAgentId],
  );
  const localTotalPages = Math.ceil(
    sortedLocalAgents.length / DISPLAY_PAGE_SIZE,
  );
  const localStartIndex = localPage * DISPLAY_PAGE_SIZE;
  const localPageAgents = sortedLocalAgents.slice(
    localStartIndex,
    localStartIndex + DISPLAY_PAGE_SIZE,
  );

  // Pagination calculations - Cloud
  const cloudTotalPages = Math.ceil(cloudAgents.length / DISPLAY_PAGE_SIZE);
  const cloudStartIndex = cloudPage * DISPLAY_PAGE_SIZE;
  const cloudPageAgents = cloudAgents.slice(
    cloudStartIndex,
    cloudStartIndex + DISPLAY_PAGE_SIZE,
  );
  const cloudCanGoNext = cloudPage < cloudTotalPages - 1 || cloudHasMore;

  // Current tab's state (computed)
  const currentLoading =
    activeTab === "pinned"
      ? pinnedLoading
      : activeTab === "local"
        ? localLoading
        : cloudLoading;
  const currentError = activeTab === "cloud" ? cloudError : null;
  const currentAgents =
    activeTab === "pinned"
      ? pinnedPageAgents.map((p) => p.agent).filter(Boolean)
      : activeTab === "local"
        ? localPageAgents
        : cloudPageAgents;
  const setCurrentSelectedIndex =
    activeTab === "pinned"
      ? setPinnedSelectedIndex
      : activeTab === "local"
        ? setLocalSelectedIndex
        : setCloudSelectedIndex;

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
    const { agent, agentId, isLocal } = viewState;
    const expectedName = agent.name || agentId.slice(0, 12);

    if (deleteConfirmInput !== expectedName) return;

    setDeleteLoading(true);
    try {
      // Use the correct backend for this agent's mode
      const backend = isLocal
        ? getBackendForMode("local")
        : getBackendForMode("api");
      await backend.deleteAgent(agentId);

      // Reset state and refresh tabs
      setViewState({ type: "list" });
      setDeleteConfirmInput("");
      // Reload pinned and invalidate cached tabs
      loadPinnedAgents();
      setLocalLoaded(false);
      setCloudLoaded(false);
    } catch {
      // Stay on confirmation screen on error
    } finally {
      setDeleteLoading(false);
    }
  }, [viewState, deleteConfirmInput, loadPinnedAgents]);

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

    // Tab key cycles through tabs
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
      if (hasCloudAuth && key.ctrl && input.toLowerCase() === "b") {
        setNewAgentBackendMode((prev) => (prev === "api" ? "local" : "api"));
        return;
      }

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
          onSelect(selected.agentId, selected.backendMode);
        }
      } else if (activeTab === "local") {
        const selected = localPageAgents[localSelectedIndex];
        if (selected?.id) {
          onSelect(selected.id, "local");
        }
      } else if (activeTab === "cloud") {
        const selected = cloudPageAgents[cloudSelectedIndex];
        if (selected?.id) {
          onSelect(selected.id, "api");
        } else if (hasCloudAuth === false) {
          onLogin?.();
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
      } else if (activeTab === "local") {
        if (localPage > 0) {
          setLocalPage((prev) => prev - 1);
          setLocalSelectedIndex(0);
        }
      } else {
        if (cloudPage > 0) {
          setCloudPage((prev) => prev - 1);
          setCloudSelectedIndex(0);
        }
      }
    } else if (key.rightArrow) {
      // Next page
      if (activeTab === "pinned") {
        if (pinnedPage < pinnedTotalPages - 1) {
          setPinnedPage((prev) => prev + 1);
          setPinnedSelectedIndex(0);
        }
      } else if (activeTab === "local") {
        if (localPage < localTotalPages - 1) {
          setLocalPage((prev) => prev + 1);
          setLocalSelectedIndex(0);
        }
      } else if (activeTab === "cloud" && cloudCanGoNext) {
        const nextPageIndex = cloudPage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= cloudAgents.length && cloudHasMore) {
          fetchMoreCloudAgents();
        }

        if (nextStartIndex < cloudAgents.length) {
          setCloudPage(nextPageIndex);
          setCloudSelectedIndex(0);
        }
      }
    } else if (
      allowPinActions &&
      activeTab === "pinned" &&
      (input === "p" || input === "P")
    ) {
      // Unpin from current scope (pinned tab only)
      const selected = pinnedPageAgents[pinnedSelectedIndex];
      if (selected) {
        const backend = getBackendForMode(selected.backendMode);
        void unpinAgentForCurrentUser(selected.agentId, backend).finally(() => {
          loadPinnedAgents();
        });
      }
    } else if (allowDelete && input === "D") {
      // Delete agent - open confirmation
      let selectedAgent: AgentState | null = null;
      let selectedAgentId: string | null = null;
      let selectedIsLocal = false;

      if (activeTab === "pinned") {
        const selected = pinnedPageAgents[pinnedSelectedIndex];
        if (selected?.agent) {
          selectedAgent = selected.agent;
          selectedAgentId = selected.agentId;
          selectedIsLocal = selected.backendMode === "local";
        }
      } else if (activeTab === "local") {
        selectedAgent = localPageAgents[localSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
        selectedIsLocal = true;
      } else {
        selectedAgent = cloudPageAgents[cloudSelectedIndex] ?? null;
        selectedAgentId = selectedAgent?.id ?? null;
        selectedIsLocal = false;
      }

      if (selectedAgent && selectedAgentId) {
        setViewState({
          type: "deleteConfirm",
          agent: selectedAgent,
          agentId: selectedAgentId,
          isLocal: selectedIsLocal,
        });
        setDeleteConfirmInput("");
      }
    } else if (showNewTab && (input === "n" || input === "N")) {
      // Switch to New tab
      setActiveTab("new");
    } else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {
      // Type to search (list tabs only)
      setSearchInput((prev) => prev + input);
    }
  });

  // Render agent item (shared between tabs)
  const renderAgentItem = (
    agent: AgentState,
    _index: number,
    isSelected: boolean,
    extra?: { backend?: "local" | "cloud" },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const isLocalAgent = isLocalAgentId(agent.id);
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCount = agent.blocks?.length ?? 0;
    const modelStr = formatModel(agent);
    const metadataParts = [
      relativeTime,
      ...(isLocalAgent
        ? []
        : [`${blockCount} memory block${blockCount === 1 ? "" : "s"}`]),
      modelStr,
    ];

    const nameLen = (agent.name || "Unnamed").length;
    const fixedChars = 2 + 3 + (isCurrent ? 10 : 0);
    const availableForId = Math.max(15, terminalWidth - nameLen - fixedChars);
    const displayId = truncateAgentId(agent.id, availableForId);

    const backendLabel = extra?.backend
      ? `${extra.backend === "local" ? "Local" : "Cloud"} · `
      : "";

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
            {extra?.backend ?? backendLabel}
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
          <Text dimColor>{metadataParts.join(" · ")}</Text>
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
      return renderAgentItem(data.agent, index, isSelected, {});
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
        </Box>
        <Box flexDirection="row" marginLeft={2}>
          <Text color="red" italic>
            {data.error}
          </Text>
        </Box>
      </Box>
    );
  };

  // Render Cloud upsell (shown when not logged in)
  const renderCloudUpsell = () => (
    <Box flexDirection="column" paddingLeft={2}>
      <Text dimColor>Sign in with Letta to see cloud-hosted agents here.</Text>
      <Box height={1} />
      <Box flexDirection="column">
        <Text color={colors.selector.itemHighlighted}>{"> /login"}</Text>
        <Box paddingLeft={2}>
          <Text dimColor>Sign in with Letta</Text>
        </Box>
      </Box>
    </Box>
  );

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
      title={title}
      footer={
        activeTab !== "new" &&
        !currentLoading &&
        (activeTab === "pinned" ||
          (activeTab === "local" && localAgents.length > 0) ||
          (activeTab === "cloud" && !cloudError && cloudAgents.length > 0))
          ? (() => {
              const footerWidth = Math.max(0, terminalWidth - 2);
              if (activeTab === "pinned" && validPinnedAgents.length === 0) {
                return (
                  <Box flexDirection="row">
                    <Box width={2} flexShrink={0} />
                    <Box flexGrow={1} width={footerWidth}>
                      <MarkdownDisplay
                        text="Tab switch · Esc cancel"
                        dimColor
                      />
                    </Box>
                  </Box>
                );
              }

              const pageText =
                activeTab === "pinned"
                  ? `Page ${pinnedPage + 1}/${pinnedTotalPages || 1}`
                  : activeTab === "local"
                    ? `Page ${localPage + 1}/${localTotalPages || 1}`
                    : `Page ${cloudPage + 1}${cloudHasMore ? "+" : `/${cloudTotalPages || 1}`}${cloudLoadingMore ? " (loading...)" : ""}`;
              const deleteHint = allowDelete ? " · Shift+D delete" : "";
              const selectedPinnedAgent =
                activeTab === "pinned"
                  ? pinnedPageAgents[pinnedSelectedIndex]
                  : undefined;
              const pinnedHint =
                allowPinActions &&
                activeTab === "pinned" &&
                selectedPinnedAgent !== undefined
                  ? " · Shift+P unpin"
                  : "";
              const hintsText = `Enter select · ↑↓ ←→ navigate · Tab switch${deleteHint}${pinnedHint} · Esc cancel`;

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
      <Box flexDirection="column" paddingLeft={1}>
        <TabBar
          tabs={visibleTabs.map((t) => t.id)}
          activeTab={activeTab}
          getLabel={(tabId) =>
            visibleTabs.find((t) => t.id === tabId)?.label ?? tabId
          }
        />
        <Text dimColor> {TAB_DESCRIPTIONS[activeTab]}</Text>
        <Box height={1} />
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

      {/* Cloud upsell when not logged in */}
      {activeTab === "cloud" &&
        !currentLoading &&
        hasCloudAuth === false &&
        renderCloudUpsell()}

      {/* Empty state */}
      {!currentLoading &&
        ((activeTab === "pinned" && validPinnedAgents.length === 0) ||
          (activeTab === "local" && localAgents.length === 0) ||
          (activeTab === "cloud" &&
            !cloudError &&
            hasCloudAuth &&
            cloudAgents.length === 0)) && (
          <Box
            flexDirection="column"
            paddingLeft={activeTab === "pinned" ? 2 : 0}
          >
            <Text dimColor>{TAB_EMPTY_STATES[activeTab]}</Text>
            {activeTab !== "pinned" && (
              <Text dimColor>Press ESC to cancel</Text>
            )}
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

      {/* Local tab content */}
      {activeTab === "local" && !localLoading && localAgents.length > 0 && (
        <Box flexDirection="column">
          {localPageAgents.map((agent, index) =>
            renderAgentItem(agent, index, index === localSelectedIndex, {
              backend: "local",
            }),
          )}
        </Box>
      )}

      {/* Cloud tab content */}
      {activeTab === "cloud" &&
        !cloudLoading &&
        !cloudError &&
        cloudAgents.length > 0 && (
          <Box flexDirection="column">
            {cloudPageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === cloudSelectedIndex, {
                backend: "cloud",
              }),
            )}
          </Box>
        )}

      {/* New tab content */}
      {activeTab === "new" && (
        <Box flexDirection="column">
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
                    onCreateNewAgent?.(
                      DEFAULT_AGENT_NAME,
                      hasCloudAuth ? newAgentBackendMode : "local",
                    );
                    return;
                  }
                  const validationError = validateAgentName(trimmed);
                  if (validationError) {
                    setNewAgentNameError(validationError);
                    return;
                  }
                  onCreateNewAgent?.(
                    trimmed,
                    hasCloudAuth ? newAgentBackendMode : "local",
                  );
                }}
                placeholder={DEFAULT_AGENT_NAME}
              />
            </Box>
          </Box>
          {hasCloudAuth && (
            <Box paddingLeft={2} marginTop={1}>
              <Text>Backend: </Text>
              <Text
                bold={newAgentBackendMode === "api"}
                color={
                  newAgentBackendMode === "api"
                    ? colors.selector.itemHighlighted
                    : colors.selector.title
                }
              >
                Cloud
              </Text>
              <Text color={colors.selector.title}> · </Text>
              <Text
                bold={newAgentBackendMode === "local"}
                color={
                  newAgentBackendMode === "local"
                    ? colors.selector.itemHighlighted
                    : colors.selector.title
                }
              >
                Local
              </Text>
            </Box>
          )}
          {newAgentNameError && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color="red">{newAgentNameError}</Text>
            </Box>
          )}
          <Box height={1} />
          <Box paddingLeft={2}>
            <Text dimColor>
              {hasCloudAuth
                ? `Enter create · Ctrl+B switch to ${newAgentBackendMode === "api" ? "Local" : "Cloud"} · Esc cancel`
                : "Enter create · Esc cancel"}
            </Text>
          </Box>
        </Box>
      )}
    </OverlayShell>
  );
}
