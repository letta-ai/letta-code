import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { getClient } from "../../agent/client";
import { colors } from "./colors";

interface AgentSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string) => void;
  onCancel: () => void;
}

export function AgentSelector({
  currentAgentId,
  onSelect,
  onCancel,
}: AgentSelectorProps) {
  const [agents, setAgents] = useState<AgentState[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    const fetchAgents = async () => {
      try {
        const client = await getClient();
        const agentList = await client.agents.list();
        setAgents(agentList.items);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      }
    };
    fetchAgents();
  }, []);

  // Debounce search query (300ms delay)
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Filter agents based on debounced search query
  const matchingAgents = agents.filter((agent) => {
    if (!debouncedQuery) return true;
    const query = debouncedQuery.toLowerCase();
    const name = (agent.name || "").toLowerCase();
    const id = (agent.id || "").toLowerCase();
    return name.includes(query) || id.includes(query);
  });
  
  const filteredAgents = matchingAgents.slice(0, 10);

  // Reset selected index when filtered list changes
  useEffect(() => {
    setSelectedIndex(0);
  }, [debouncedQuery]);

  useInput((input, key) => {
    if (loading || error) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(filteredAgents.length - 1, prev + 1));
    } else if (key.return) {
      const selectedAgent = filteredAgents[selectedIndex];
      if (selectedAgent?.id) {
        onSelect(selectedAgent.id);
      }
    } else if (key.escape) {
      onCancel();
    } else if (key.backspace || key.delete) {
      setSearchQuery((prev) => prev.slice(0, -1));
    } else if (input && !key.ctrl && !key.meta) {
      // Add regular characters to search query
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

  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={colors.selector.title}>No agents found</Text>
        <Text dimColor>Press ESC to cancel</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Select Agent (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
      </Box>

      <Box>
        <Text dimColor>Search: </Text>
        <Text>{searchQuery || "_"}</Text>
      </Box>

      {filteredAgents.length === 0 && (
        <Box>
          <Text dimColor>No agents match your search</Text>
        </Box>
      )}

      {filteredAgents.length > 0 && (
        <Box>
          <Text dimColor>
            Showing {filteredAgents.length}{matchingAgents.length > 10 ? ` of ${matchingAgents.length}` : ""}{debouncedQuery ? " matching" : ""} agents
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {filteredAgents.map((agent, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = agent.id === currentAgentId;

          const lastInteractedAt = agent.last_run_completion
            ? new Date(agent.last_run_completion).toLocaleString()
            : "Never";

          return (
            <Box key={agent.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Box flexDirection="row" gap={2}>
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  wrap="truncate-end"
                >
                  {agent.name || "Unnamed"}
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {agent.id}
                </Text>
                <Text dimColor wrap="truncate-end">
                  {lastInteractedAt}
                </Text>
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
