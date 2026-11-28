import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type AgentBackendMode, isLocalAgentId } from "@/agent/agent-id";
import { unpinAgentForCurrentUser } from "@/agent/favorites";
import { getBackendForMode } from "@/backend/backend";
import {
  FETCH_PAGE_SIZE,
  fetchCloudAgentPage,
} from "@/cli/helpers/cloud-agent-page";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";
import {
  hasCloudCredentials,
  listPinnedAgentsForCurrentUser,
} from "@/cli/helpers/pinned-agent-listing";
import { listSharedAgentsForCurrentUser } from "@/cli/helpers/shared-agent-listing";
import { useTerminalWidth } from "@/cli/hooks/use-terminal-width";
import { DEFAULT_AGENT_NAME } from "@/constants";
import { AgentSelectorFooter } from "./AgentSelectorFooter";
import {
  AgentDeleteConfirmOverlay,
  CloudLoginPrompt,
} from "./AgentSelectorViews";
import type {
  AgentSelectorProps,
  PickerPin,
  ViewState,
} from "./agent-selector-utils";
import {
  AGENT_SELECTOR_TAB_DESCRIPTIONS,
  AGENT_SELECTOR_TAB_EMPTY_STATES,
  type AgentSelectorListAgent,
  type AgentSelectorTabId,
  formatAgentMemoryBlockCount,
  formatAgentModel,
  formatRelativeTime,
  getVisibleAgentSelectorTabs,
  listSessionLocalAgents,
  truncateAgentId,
} from "./agent-selector-utils";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { PasteAwareTextInput } from "./PasteAwareTextInput";
import { validateAgentName } from "./PinDialog";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const DISPLAY_PAGE_SIZE = 5;
const NEW_AGENT_DEFAULT_BACKEND: AgentBackendMode = "api";

export function AgentSelector({
  currentAgentId,
  sessionList,
  sessionCollection,
  sessionDelete,
  sessionUnpin,
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

  const [hasLocalAgents, setHasLocalAgents] = useState(() => {
    if (sessionList) return isLocalAgentId(currentAgentId);
    try {
      return listLocalAgentsFromDisk().length > 0;
    } catch {
      return false;
    }
  });
  const [hasCloudAuth, setHasCloudAuth] = useState<boolean | null>(null);

  const visibleTabs = useMemo(
    () =>
      getVisibleAgentSelectorTabs({ showNewTab, hasLocalAgents, hasCloudAuth }),
    [hasCloudAuth, hasLocalAgents, showNewTab],
  );

  const [activeTab, setActiveTab] = useState<AgentSelectorTabId>("pinned");

  useEffect(() => {
    if (activeTab === "local" && !hasLocalAgents) {
      setActiveTab("cloud");
    } else if (activeTab === "shared" && hasCloudAuth !== true) {
      setActiveTab("cloud");
    } else if (activeTab === "new" && !showNewTab) {
      setActiveTab("pinned");
    }
  }, [activeTab, hasCloudAuth, hasLocalAgents, showNewTab]);

  const [pinnedAgents, setPinnedAgents] = useState<PickerPin[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(true);
  const [pinnedSelectedIndex, setPinnedSelectedIndex] = useState(0);
  const [pinnedPage, setPinnedPage] = useState(0);

  const [localAgents, setLocalAgents] = useState<AgentSelectorListAgent[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localSelectedIndex, setLocalSelectedIndex] = useState(0);
  const [localPage, setLocalPage] = useState(0);
  const [localLoaded, setLocalLoaded] = useState(false);

  const [cloudAgents, setCloudAgents] = useState<AgentSelectorListAgent[]>([]);
  const [cloudCursor, setCloudCursor] = useState<string | null>(null);
  const [cloudLoading, setCloudLoading] = useState(false);
  const [cloudLoadingMore, setCloudLoadingMore] = useState(false);
  const [cloudHasMore, setCloudHasMore] = useState(true);
  const [cloudSelectedIndex, setCloudSelectedIndex] = useState(0);
  const [cloudPage, setCloudPage] = useState(0);
  const [cloudError, setCloudError] = useState<string | null>(null);
  const [cloudLoaded, setCloudLoaded] = useState(false);
  const [cloudQuery, setCloudQuery] = useState<string>("");

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

  const [searchInput, setSearchInput] = useState("");
  const [activeQuery, setActiveQuery] = useState("");

  const [viewState, setViewState] = useState<ViewState>({ type: "list" });
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");
  const [deleteLoading, setDeleteLoading] = useState(false);

  const [newAgentNameInput, setNewAgentNameInput] = useState("");
  const [newAgentNameError, setNewAgentNameError] = useState("");
  const [newAgentBackendMode, setNewAgentBackendMode] =
    useState<AgentBackendMode>(NEW_AGENT_DEFAULT_BACKEND);

  const loadPinnedAgents = useCallback(async () => {
    setPinnedLoading(true);
    try {
      const pinnedData = sessionCollection
        ? (await sessionCollection("pinned")).agents.map((agent) => ({
            agent,
            agentId: agent.id,
            backendMode: isLocalAgentId(agent.id)
              ? ("local" as const)
              : ("api" as const),
            error: null,
          }))
        : await listPinnedAgentsForCurrentUser();
      const validPinnedData = pinnedData.filter((p) => p.agent !== null);

      if (validPinnedData.length === 0) {
        setPinnedAgents([]);
        setPinnedLoading(false);
        return;
      }

      setPinnedAgents(pinnedData);
    } catch {
      setPinnedAgents([]);
      if (sessionCollection)
        setActiveTab(isLocalAgentId(currentAgentId) ? "local" : "cloud");
    } finally {
      setPinnedLoading(false);
    }
  }, [sessionCollection, currentAgentId]);

  const loadLocalAgents = useCallback(async () => {
    setLocalLoading(true);
    try {
      const agents = sessionList
        ? await listSessionLocalAgents(sessionList)
        : listLocalAgentsFromDisk();
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
  }, [sessionList]);

  const fetchCloudAgents = sessionList ?? fetchCloudAgentPage;

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

  const loadSharedAgents = useCallback(
    async (query?: string) => {
      setSharedLoading(true);
      setSharedError(null);
      try {
        const result = sessionCollection
          ? await sessionCollection("shared", null, query)
          : await listSharedAgentsForCurrentUser({
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
    },
    [sessionCollection],
  );

  const fetchMoreSharedAgents = useCallback(async () => {
    if (sharedLoadingMore || !sharedHasMore || !sharedCursor) return;

    setSharedLoadingMore(true);
    try {
      const result = sessionCollection
        ? await sessionCollection("shared", sharedCursor, activeQuery)
        : await listSharedAgentsForCurrentUser({
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
    } finally {
      setSharedLoadingMore(false);
    }
  }, [
    sharedLoadingMore,
    sharedHasMore,
    sharedCursor,
    activeQuery,
    sessionCollection,
  ]);

  useEffect(() => {
    setHasCloudAuth(
      sessionList ? !isLocalAgentId(currentAgentId) : hasCloudCredentials(),
    );
  }, [sessionList, currentAgentId]);

  useEffect(() => {
    loadPinnedAgents();
  }, [loadPinnedAgents]);

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

  const validPinnedAgents = pinnedAgents.filter((p) => p.agent !== null);
  const pinnedTotalPages = Math.ceil(
    validPinnedAgents.length / DISPLAY_PAGE_SIZE,
  );
  const pinnedStartIndex = pinnedPage * DISPLAY_PAGE_SIZE;
  const pinnedPageAgents = validPinnedAgents.slice(
    pinnedStartIndex,
    pinnedStartIndex + DISPLAY_PAGE_SIZE,
  );

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

  const cloudTotalPages = Math.ceil(cloudAgents.length / DISPLAY_PAGE_SIZE);
  const cloudStartIndex = cloudPage * DISPLAY_PAGE_SIZE;
  const cloudPageAgents = cloudAgents.slice(
    cloudStartIndex,
    cloudStartIndex + DISPLAY_PAGE_SIZE,
  );
  const cloudCanGoNext = cloudPage < cloudTotalPages - 1 || cloudHasMore;

  const sharedTotalPages = Math.ceil(sharedAgents.length / DISPLAY_PAGE_SIZE);
  const sharedStartIndex = sharedPage * DISPLAY_PAGE_SIZE;
  const sharedPageAgents = sharedAgents.slice(
    sharedStartIndex,
    sharedStartIndex + DISPLAY_PAGE_SIZE,
  );
  const sharedCanGoNext = sharedPage < sharedTotalPages - 1 || sharedHasMore;

  let currentLoading = false;
  let currentError: string | null = null;
  let currentAgents: AgentSelectorListAgent[] = [];
  let setCurrentSelectedIndex = setCloudSelectedIndex;
  if (activeTab === "pinned") {
    currentLoading = pinnedLoading;
    currentAgents = pinnedPageAgents
      .map((p) => p.agent)
      .filter((agent): agent is AgentSelectorListAgent => agent !== null);
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

  const submitSearch = useCallback(() => {
    if (searchInput !== activeQuery) {
      setActiveQuery(searchInput);
    }
  }, [searchInput, activeQuery]);

  const clearSearch = useCallback(() => {
    setSearchInput("");
    if (activeQuery) {
      setActiveQuery("");
    }
  }, [activeQuery]);

  const handleDeleteAgent = useCallback(async () => {
    if (viewState.type !== "deleteConfirm") return;
    const { agent, agentId, isLocal } = viewState;
    const expectedName = agent.name || agentId.slice(0, 12);

    if (deleteConfirmInput !== expectedName) return;

    setDeleteLoading(true);
    try {
      if (sessionDelete) await sessionDelete(agentId);
      else
        await getBackendForMode(isLocal ? "local" : "api").deleteAgent(agentId);

      setViewState({ type: "list" });
      setDeleteConfirmInput("");
      loadPinnedAgents();
      setLocalLoaded(false);
      setCloudLoaded(false);
      setSharedLoaded(false);
    } catch {
    } finally {
      setDeleteLoading(false);
    }
  }, [viewState, deleteConfirmInput, loadPinnedAgents, sessionDelete]);

  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      onCancel();
      return;
    }

    if (viewState.type === "deleteConfirm") {
      if (key.escape) {
        setViewState({ type: "list" });
        setDeleteConfirmInput("");
        return;
      }

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

    if (key.tab) {
      const currentIndex = visibleTabs.findIndex((t) => t.id === activeTab);
      const nextIndex = (currentIndex + 1) % visibleTabs.length;
      setActiveTab(visibleTabs[nextIndex]?.id ?? "pinned");
      return;
    }

    if (currentLoading) return;

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
      if (
        activeTab !== "pinned" &&
        searchInput &&
        searchInput !== activeQuery
      ) {
        submitSearch();
        return;
      }

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
      const selected = pinnedPageAgents[pinnedSelectedIndex];
      if (selected) {
        const op = sessionUnpin
          ? sessionUnpin(selected.agentId)
          : unpinAgentForCurrentUser(
              selected.agentId,
              getBackendForMode(selected.backendMode),
            );
        void op.then(loadPinnedAgents).catch(() => loadPinnedAgents());
      }
    } else if (allowDelete && input === "D" && activeTab !== "shared") {
      let selectedAgent: AgentSelectorListAgent | null = null;
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
      setActiveTab("new");
    } else if (activeTab !== "pinned" && input && !key.ctrl && !key.meta) {
      setSearchInput((prev) => prev + input);
    }
  });
  const renderAgentItem = (
    agent: AgentSelectorListAgent,
    _index: number,
    isSelected: boolean,
    extra?: { backend?: "local" | "cloud" | "shared" },
  ) => {
    const isCurrent = agent.id === currentAgentId;
    const isLocalAgent = isLocalAgentId(agent.id);
    const relativeTime = formatRelativeTime(agent.last_run_completion);
    const blockCountText = formatAgentMemoryBlockCount(
      agent.memoryBlockCount ?? agent.blocks?.length,
    );
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

    const backendLabel = extra?.backend
      ? { local: "Local · ", cloud: "Cloud · ", shared: "Shared · " }[
          extra.backend
        ]
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

  const renderPinnedItem = (
    data: PickerPin,
    index: number,
    isSelected: boolean,
  ) => {
    if (data.agent) {
      return renderAgentItem(data.agent, index, isSelected, {});
    }

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

      {activeTab !== "pinned" && currentError && (
        <Box flexDirection="column">
          <Text color="red">Error: {currentError}</Text>
          <Text dimColor>Press ESC to cancel</Text>
        </Box>
      )}

      {currentLoading && (
        <Box>
          <Text dimColor>{"  "}Loading agents...</Text>
        </Box>
      )}

      {activeTab === "cloud" && !currentLoading && hasCloudAuth === false && (
        <CloudLoginPrompt loginCommand="/login" />
      )}

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

      {activeTab === "pinned" &&
        !pinnedLoading &&
        validPinnedAgents.length > 0 && (
          <Box flexDirection="column">
            {pinnedPageAgents.map((data, index) =>
              renderPinnedItem(data, index, index === pinnedSelectedIndex),
            )}
          </Box>
        )}

      {activeTab === "local" && !localLoading && localAgents.length > 0 && (
        <Box flexDirection="column">
          {localPageAgents.map((agent, index) =>
            renderAgentItem(agent, index, index === localSelectedIndex, {
              backend: "local",
            }),
          )}
        </Box>
      )}

      {activeTab === "cloud" &&
        !cloudLoading &&
        !cloudError &&
        cloudAgents.length > 0 && (
          <Box flexDirection="column">
            {cloudPageAgents.map((agent, index) =>
              renderAgentItem(agent, index, index === cloudSelectedIndex, {
                backend:
                  sessionList && isLocalAgentId(agent.id) ? "local" : "cloud",
              }),
            )}
          </Box>
        )}

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
