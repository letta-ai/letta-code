// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import SpinnerLib from "ink-spinner";
import type { ComponentType } from "react";
import { useEffect, useState } from "react";
import { getClient } from "../../agent/client";
import { colors } from "./colors";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";

// Type assertion for ink-spinner compatibility
const Spinner = SpinnerLib as ComponentType<{ type?: string }>;

interface AgentCleanupProps {
  currentAgentId: string;
  onClose: () => void;
}

const PAGE_SIZE = 25;
const VIEWPORT_SIZE = 5;

type ViewMode = "list" | "search" | "deleting" | "success" | "error";

export function AgentCleanup({
  currentAgentId,
  onClose,
}: AgentCleanupProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [loading, setLoading] = useState(true);
  const [initialLoad, setInitialLoad] = useState(true);
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [pageCursors, setPageCursors] = useState<Map<number, string | undefined>>(new Map([[1, undefined]]));
  const [searchQuery, setSearchQuery] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [markedForDeletion, setMarkedForDeletion] = useState<Set<string>>(
    new Set(),
  );
  const [statusMessage, setStatusMessage] = useState("");

  // Fetch agents with pagination
  const fetchAgents = async (page: number, search: string = "") => {
    setLoading(true);
    try {
      const client = await getClient();
      const cursor = pageCursors.get(page);
      const response = await client.agents.list({
        limit: PAGE_SIZE,
        after: cursor,
      });

      let agentsList = response.items || [];
      
      // Filter out current agent
      agentsList = agentsList.filter((agent) => agent.id !== currentAgentId);

      // Apply search filter if provided
      if (search.trim()) {
        const lowerSearch = search.toLowerCase();
        agentsList = agentsList.filter((agent) =>
          (agent.name || "").toLowerCase().includes(lowerSearch) ||
          agent.id.toLowerCase().includes(lowerSearch)
        );
      }

      setAgents(agentsList);
      const hasNext = response.hasNextPage ? response.hasNextPage() : false;
      setHasNextPage(hasNext);
      
      // Store cursor for next page if there is one
      if (hasNext && agentsList.length > 0) {
        const lastAgent = agentsList[agentsList.length - 1];
        setPageCursors(prev => new Map(prev).set(page + 1, lastAgent?.id));
      }
      
      setSelectedIndex(0);
      setInitialLoad(false);
    } catch (error) {
      setViewMode("error");
      setStatusMessage(`Failed to fetch agents: ${error instanceof Error ? error.message : String(error)}`);
      setInitialLoad(false);
    } finally {
      setLoading(false);
    }
  };

  // Initial fetch
  useEffect(() => {
    fetchAgents(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Handle deletion
  const handleDelete = async () => {
    if (markedForDeletion.size === 0) return;

    setViewMode("deleting");
    setStatusMessage(`Deleting ${markedForDeletion.size} agent${markedForDeletion.size > 1 ? "s" : ""}...`);

    try {
      const client = await getClient();
      let successCount = 0;
      let failCount = 0;

      for (const agentId of Array.from(markedForDeletion)) {
        try {
          await client.agents.delete(agentId);
          successCount++;
        } catch (error) {
          console.error(`Failed to delete agent ${agentId}:`, error);
          failCount++;
        }
      }

      if (failCount === 0) {
        setViewMode("success");
        setStatusMessage(`Successfully deleted ${successCount} agent${successCount > 1 ? "s" : ""}`);
      } else {
        setViewMode("error");
        setStatusMessage(`Deleted ${successCount}, failed ${failCount}`);
      }

      // Refresh the list after a delay
      setTimeout(() => {
        setMarkedForDeletion(new Set());
        setCurrentPage(1);
        setPageCursors(new Map([[1, undefined]]));
        fetchAgents(1, searchQuery);
        setViewMode("list");
      }, 1500);
    } catch (error) {
      setViewMode("error");
      setStatusMessage(`Failed: ${error instanceof Error ? error.message : String(error)}`);
      setTimeout(() => {
        setViewMode("list");
      }, 2000);
    }
  };

  // Handle search submission
  const handleSearch = () => {
    setSearchQuery(searchInput);
    setCurrentPage(1);
    setPageCursors(new Map([[1, undefined]]));
    fetchAgents(1, searchInput);
    setViewMode("list");
  };

  // Handle search mode input
  useInput((input, key) => {
    if (viewMode === "search") {
      if (key.return) {
        handleSearch();
      } else if (key.escape) {
        setViewMode("list");
        setSearchInput("");
      } else if (key.backspace || key.delete) {
        setSearchInput((prev) => prev.slice(0, -1));
      } else if (input && !key.ctrl && !key.meta) {
        setSearchInput((prev) => prev + input);
      }
      return;
    }

    // List mode navigation
    if (viewMode !== "list" || loading) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(agents.length - 1, prev + 1));
    } else if (key.leftArrow && currentPage > 1) {
      setCurrentPage((prev) => prev - 1);
      fetchAgents(currentPage - 1, searchQuery);
    } else if (key.rightArrow && hasNextPage) {
      setCurrentPage((prev) => prev + 1);
      fetchAgents(currentPage + 1, searchQuery);
    } else if (input === " ") {
      // Toggle selection with spacebar
      const agent = agents[selectedIndex];
      if (agent) {
        setMarkedForDeletion((prev) => {
          const newSet = new Set(prev);
          if (newSet.has(agent.id)) {
            newSet.delete(agent.id);
          } else {
            newSet.add(agent.id);
          }
          return newSet;
        });
      }
    } else if (input === "/") {
      setViewMode("search");
      setSearchInput("");
    } else if (key.return) {
      // Confirm deletion
      handleDelete();
    } else if (key.escape) {
      onClose();
    }
  });

  // Calculate viewport
  const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(VIEWPORT_SIZE / 2), agents.length - VIEWPORT_SIZE));
  const endIndex = Math.min(startIndex + VIEWPORT_SIZE, agents.length);
  const visibleAgents = agents.slice(startIndex, endIndex);
  const showScrollUp = startIndex > 0;
  const showScrollDown = endIndex < agents.length;

  // Initial loading state
  if (initialLoad) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text color={colors.selector.title}>
            <Spinner type="dots" />
          </Text>
          <Text bold color={colors.selector.title}>
            Loading agents...
          </Text>
        </Box>
      </Box>
    );
  }

  // Status views (deleting, success, error)
  if (viewMode === "deleting" || viewMode === "success" || viewMode === "error") {
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          {viewMode === "deleting" && (
            <Text color={colors.selector.title}>
              <Spinner type="dots" />
            </Text>
          )}
          <Text
            bold
            color={
              viewMode === "success"
                ? colors.status.success
                : viewMode === "error"
                  ? colors.status.error
                  : colors.selector.title
            }
          >
            {statusMessage}
          </Text>
        </Box>
        {viewMode === "deleting" && (
          <Box>
            <Text dimColor>(This may take a while...)</Text>
          </Box>
        )}
      </Box>
    );
  }

  // Search mode
  if (viewMode === "search") {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold color={colors.selector.title}>
            Search Agents
          </Text>
        </Box>
        <Box>
          <Text>/ </Text>
          <Text>{searchInput}</Text>
          <Text dimColor>█</Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>Enter to search, ESC to cancel</Text>
        </Box>
      </Box>
    );
  }

  // No agents found
  if (agents.length === 0) {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold color={colors.selector.title}>
            {searchQuery ? "No agents found matching search" : "No agents available to delete"}
          </Text>
        </Box>
        <Box marginTop={1}>
          <Text dimColor>
            {searchQuery ? "Press / to search again, " : ""}Press ESC to close
          </Text>
        </Box>
      </Box>
    );
  }

  // Main list view
  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Select Agents to Delete
        </Text>
      </Box>

      <Box flexDirection="column">
        {showScrollUp && (
          <Box>
            <Text dimColor>  ↑ {startIndex} more above</Text>
          </Box>
        )}

        {visibleAgents.map((agent, viewportIndex) => {
          const actualIndex = startIndex + viewportIndex;
          const isSelected = actualIndex === selectedIndex;
          const isMarked = markedForDeletion.has(agent.id);

          return (
            <Box key={agent.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Text
                color={
                  isMarked
                    ? colors.error
                    : isSelected
                      ? colors.selector.itemHighlighted
                      : undefined
                }
              >
                {isMarked ? "☑" : "☐"}
              </Text>
              <Box flexDirection="column">
                <Text
                  bold={isSelected}
                  color={
                    isMarked
                      ? colors.error
                      : isSelected
                        ? colors.selector.itemHighlighted
                        : undefined
                  }
                >
                  {agent.name || "Unnamed Agent"}
                </Text>
                <Text dimColor>{agent.id}</Text>
              </Box>
            </Box>
          );
        })}

        {showScrollDown && (
          <Box>
            <Text dimColor>
              {"  "}↓ {agents.length - endIndex} more below
            </Text>
          </Box>
        )}
      </Box>

      <Box marginTop={1} flexDirection="column" gap={0}>
        <Box>
          <Text dimColor>
            Page {currentPage}{hasNextPage ? " • More pages available" : " • Last page"}
            {searchQuery && ` • Filtered by "${searchQuery}"`}
          </Text>
        </Box>
        <Box>
          <Text dimColor>
            {markedForDeletion.size > 0
              ? `${markedForDeletion.size} agent${markedForDeletion.size > 1 ? "s" : ""} selected`
              : "No agents selected"}
          </Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>
          Space: toggle • Enter: delete • /: search • ←→: page • ESC: cancel
        </Text>
      </Box>
    </Box>
  );
}
