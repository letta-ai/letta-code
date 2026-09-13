import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { getBackendForMode } from "@/backend/backend";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import {
  hasCloudCredentials,
  listPinnedAgentsForCurrentUser,
  type PinnedAgentData,
} from "@/cli/helpers/pinned-agent-listing";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { AgentSelectorFooter } from "./AgentSelectorFooter";
import {
  AgentDeleteConfirmOverlay,
  CloudLoginPrompt,
} from "./AgentSelectorViews";
import {
  AGENT_SELECTOR_TAB_DESCRIPTIONS,
  AGENT_SELECTOR_TAB_EMPTY_STATES,
  type AgentSelectorListAgent,
  type AgentSelectorTabId,
  formatAgentMemoryBlockCount,
  formatAgentModel,
  formatRelativeTime,
  getVisibleAgentSelectorTabs,
  truncateAgentId,
} from "./agent-selector-utils";
import { colors } from "./colors";
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

type ViewState =
  | { type: "list" }
  | {
      type: "deleteConfirm";
      agent: AgentState;
      agentId: string;
      isLocal: boolean;
    };

const DISPLAY_PAGE_SIZE = 5;
const FETCH_PAGE_SIZE = 20;
const NEW_AGENT_DEFAULT_BACKEND: AgentBackendMode = "api";

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
  const [hasCloudAuth, setHasCloudAuth] = useState<boolean | null>(null);

  // Compute visible tabs — Local tab only shown when there are local agents
  const visibleTabs = useMemo(
    () =>
      getVisibleAgentSelectorTabs({ showNewTab, hasLocalAgents, hasCloudAuth }),
    [hasCloudAuth, hasLocalAgents, showNewTab],
  );

  const [activeTab, setActiveTab] = useState<AgentSelectorTabId>("pinned");

  // If active tab is no longer visible (e.g. local tab hidden after deleting all local agents), fall back
  useEffect(() => {
    if (activeTab === "local" && !hasLocalAgents) {
      setActiveTab("cloud");
    } else if (activeTab === "shared" && hasCloudAuth !== true) {
      setActiveTab("cloud");
    } else if (activeTab === "new" && !showNewTab) {
      setActiveTab("pinned");
    }
  }, [activeTab, hasCloudAuth, hasLocalAgents, showNewTab]);

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

  // Shared tab state (fetches from Cloud's shared-with-me endpoint)
  const [sharedAgents, setSharedAgents] = useState<AgentSelectorListAgent[]>(
    [],
  );
  const [sharedCursor, setSharedCursor] = useState<string | null>(null);
  const [sharedLoading, setSharedLoading] = useState(false);
  const [sharedLoadingMore, setSharedLoadingMore] = useState(false);
  const [sharedHasMore, setSharedHasMore] = useState(true);
  const [sharedSelectedIndex, setSharedSelectedIndex] = useState(0);
  const [sharedPage, setSharedPage] = useState(0);
  const [sharedError, setSharedError] = useState<string | null>(null);
  const [sharedLoaded, setSharedLoaded] = useState(false);
  const [sharedQuery, setSharedQuery] = useState<string>("");

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

  const loadSharedAgents = useCallback(async (query?: string) => {
    setSharedLoading(true);
    setSharedError(null);
    try {
      const result = await listSharedAgentsForCurrentUser({
        limit: FETCH_PAGE_SIZE,
        order: "desc",
        orderBy: "last_run_completion",
        queryText: query,
      });
      setSharedAgents(result.agents);
      setSharedCursor(result.nextCursor ?? null);
      setSharedHasMore(Boolean(result.nextCursor));
      setSharedPage(0);
      setSharedSelectedIndex(0);
      setSharedLoaded(true);
      setSharedQuery(query || "");
    } catch (err) {
      setSharedError(err instanceof Error ? err.message : String(err));
    } finally {
      setSharedLoading(false);
    }
  }, []);

  const fetchMoreSharedAgents = useCallback(async () => {
    if (sharedLoadingMore || !sharedHasMore || !sharedCursor) return;

    setSharedLoadingMore(true);
    try {
      const result = await listSharedAgentsForCurrentUser({
        limit: FETCH_PAGE_SIZE,
        after: sharedCursor,
        order: "desc",
        orderBy: "last_run_completion",
        queryText: activeQuery || undefined,
      });
      setSharedAgents((prev) => [...prev, ...result.agents]);
      setSharedCursor(result.nextCursor ?? null);
      setSharedHasMore(Boolean(result.nextCursor));
    } catch {
      // Silently fail on pagination errors
    } finally {
      setSharedLoadingMore(false);
    }
  }, [sharedLoadingMore, sharedHasMore, sharedCursor, activeQuery]);

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
    } else if (
      activeTab === "shared" &&
      !sharedLoaded &&
      !sharedLoading &&
      hasCloudAuth
    ) {
      loadSharedAgents();
    }
  }, [
    activeTab,
    localLoaded,
    localLoading,
    loadLocalAgents,
    cloudLoaded,
    cloudLoading,
    loadCloudAgents,
    sharedLoaded,
    sharedLoading,
    loadSharedAgents,
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
    if (activeTab === "shared" && hasCloudAuth && activeQuery !== sharedQuery) {
      loadSharedAgents(activeQuery || undefined);
    }
  }, [
    activeQuery,
    activeTab,
    cloudQuery,
    loadCloudAgents,
    sharedQuery,
    loadSharedAgents,
    hasCloudAuth,
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

  // Pagination calculations - Shared
  const sharedTotalPages = Math.ceil(sharedAgents.length / DISPLAY_PAGE_SIZE);
  const sharedStartIndex = sharedPage * DISPLAY_PAGE_SIZE;
  const sharedPageAgents = sharedAgents.slice(
    sharedStartIndex,
    sharedStartIndex + DISPLAY_PAGE_SIZE,
  );
  const sharedCanGoNext = sharedPage < sharedTotalPages - 1 || sharedHasMore;

  // Current tab's state (computed)
  let currentLoading = false;
  let currentError: string | null = null;
  let currentAgents: AgentSelectorListAgent[] = [];
  let setCurrentSelectedIndex = setCloudSelectedIndex;
  if (activeTab === "pinned") {
    currentLoading = pinnedLoading;
    currentAgents = pinnedPageAgents
      .map((p) => p.agent)
      .filter((agent): agent is AgentState => agent !== null);
    setCurrentSelectedIndex = setPinnedSelectedIndex;
  } else if (activeTab === "local") {
    currentLoading = localLoading;
    currentAgents = localPageAgents;
    setCurrentSelectedIndex = setLocalSelectedIndex;
  } else if (activeTab === "shared") {
    currentLoading = sharedLoading;
    currentError = sharedError;
    currentAgents = sharedPageAgents;
    setCurrentSelectedIndex = setSharedSelectedIndex;
  } else if (activeTab === "cloud") {
    currentLoading = cloudLoading;
    currentError = cloudError;
    currentAgents = cloudPageAgents;
  }

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
      setSharedLoaded(false);
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

    const maxIndex = currentAgents.length - 1;

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
      } else if (activeTab === "shared") {
        const selected = sharedPageAgents[sharedSelectedIndex];
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
      } else if (activeTab === "shared") {
        if (sharedPage > 0) {
          setSharedPage((prev) => prev - 1);
          setSharedSelectedIndex(0);
        }
      } else if (activeTab === "cloud") {
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
      } else if (activeTab === "shared" && sharedCanGoNext) {
        const nextPageIndex = sharedPage + 1;
        const nextStartIndex = nextPageIndex * DISPLAY_PAGE_SIZE;

        if (nextStartIndex >= sharedAgents.length && sharedHasMore) {
          fetchMoreSharedAgents();
        }

        if (nextStartIndex < sharedAgents.length) {
          setSharedPage(nextPageIndex);
          setSharedSelectedIndex(0);
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
    } else if (allowDelete && input === "D" && activeTab !== "shared") {
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
    agent: AgentSelectorListAgent,
    _index: number,
    isSelected: boolean,
    extra?: { backend?: "local" | "cloud" | "shared" },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const isLocalAgent = isLocalAgentId(agent.id);
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCountText = formatAgentMemoryBlockCount(agent.blocks?.length);
    const modelStr = formatAgentModel(agent);
    const metadataParts = [relativeTime];
    if (!isLocalAgent && extra?.backend !== "shared") {
      if (blockCountText) {
        metadataParts.push(blockCountText);
      }
      metadataParts.push(modelStr);
    }
    if (extra?.backend === "shared" && agent.creator?.name) {
      metadataParts.push(`Shared by ${agent.creator.name}`);
    }

    const nameLen = (agent.name || "Unnamed").length;
    const fixedChars = 2 + 3 + (isCurrent ? 10 : 0);
    const availableForId = Math.max(15, terminalWidth - nameLen - fixedChars);
    const displayId = truncateAgentId(agent.id, availableForId);

    let backendLabel = "";
    if (extra?.backend === "local") {
      backendLabel = "Local · ";
    } else if (extra?.backend === "cloud") {
      backendLabel = "Cloud · ";
    } else if (extra?.backend === "shared") {
      backendLabel = "Shared · ";
    }

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
            {backendLabel}
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

  // If in delete confirmation view, render that instead of the list
  if (viewState.type === "deleteConfirm") {
    const displayName = viewState.agent.name || viewState.agentId.slice(0, 12);
    return (
      <AgentDeleteConfirmOverlay
        command={command}
        displayName={displayName}
        input={deleteConfirmInput}
        loading={deleteLoading}
      />
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
          (!currentError && currentAgents.length > 0)) ? (
          <AgentSelectorFooter
            terminalWidth={terminalWidth}
            activeTab={activeTab}
            pinnedPage={pinnedPage}
            pinnedTotalPages={pinnedTotalPages}
            pinnedAgentsCount={validPinnedAgents.length}
            localPage={localPage}
            localTotalPages={localTotalPages}
            cloudPage={cloudPage}
            cloudTotalPages={cloudTotalPages}
            cloudHasMore={cloudHasMore}
            cloudLoadingMore={cloudLoadingMore}
            sharedPage={sharedPage}
            sharedTotalPages={sharedTotalPages}
            sharedHasMore={sharedHasMore}
            sharedLoadingMore={sharedLoadingMore}
            allowDelete={allowDelete}
            allowPinActions={allowPinActions}
            hasSelectedPinnedAgent={
              pinnedPageAgents[pinnedSelectedIndex] !== undefined
            }
          />
        ) : undefined
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
        <Text dimColor> {AGENT_SELECTOR_TAB_DESCRIPTIONS[activeTab]}</Text>
        <Box height={1} />
      </Box>

      {/* Search input - list tabs only */}
      {activeTab !== "pinned" &&
        activeTab !== "new" &&
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
      {activeTab === "cloud" && !currentLoading && hasCloudAuth === false && (
        <CloudLoginPrompt loginCommand="/login" />
      )}

      {/* Empty state */}
      {!currentLoading &&
        ((activeTab === "pinned" && validPinnedAgents.length === 0) ||
          (activeTab !== "new" &&
            activeTab !== "pinned" &&
            !currentError &&
            hasCloudAuth !== false &&
            currentAgents.length === 0)) && (
          <Box
            flexDirection="column"
            paddingLeft={activeTab === "pinned" ? 2 : 0}
          >
            <Text dimColor>{AGENT_SELECTOR_TAB_EMPTY_STATES[activeTab]}</Text>
            {activeTab !== "pinned" && (
              <Text dimColor>Press ESC to cancel</Text>
            )}
          </Box>
        )}

      {/* Shared tab content */}
      {activeTab === "shared" &&
        !sharedLoading &&
        !sharedError &&
        sharedAgents.length > 0 && (
          <Box flexDirection="column">
            {sharedPageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === sharedSelectedIndex, {
                backend: "shared",
              }),
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
