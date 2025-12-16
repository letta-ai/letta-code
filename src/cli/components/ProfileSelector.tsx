import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, Text, useInput } from "ink";
import { memo, useCallback, useEffect, useState } from "react";
import { getClient } from "../../agent/client";
import { settingsManager } from "../../settings-manager";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

interface ProfileSelectorProps {
  currentAgentId: string;
  onSelect: (agentId: string) => void;
  onUnpin: (agentId: string) => void;
  onCancel: () => void;
}

interface ProfileData {
  name: string;
  agentId: string;
  agent: AgentState | null;
  error: string | null;
  isLocal: boolean; // true = project-level pin, false = global pin
}

const DISPLAY_PAGE_SIZE = 5;

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
 * Format model string to show provider/model-name
 */
function formatModel(agent: AgentState): string {
  if (agent.model) {
    return agent.model;
  }
  if (agent.llm_config?.model) {
    const provider = agent.llm_config.model_endpoint_type || "unknown";
    return `${provider}/${agent.llm_config.model}`;
  }
  return "unknown";
}

type Mode = "browsing" | "confirming-delete";

export const ProfileSelector = memo(function ProfileSelector({
  currentAgentId,
  onSelect,
  onUnpin,
  onCancel,
}: ProfileSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const [profiles, setProfiles] = useState<ProfileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [mode, setMode] = useState<Mode>("browsing");
  const [deleteConfirmIndex, setDeleteConfirmIndex] = useState(0);

  // Load pinned agents and fetch agent data
  const loadProfiles = useCallback(async () => {
    setLoading(true);
    try {
      const mergedPinned = settingsManager.getMergedPinnedAgents();

      if (mergedPinned.length === 0) {
        setProfiles([]);
        setLoading(false);
        return;
      }

      const client = await getClient();

      // Fetch agent data for each pinned agent
      const profileDataPromises = mergedPinned.map(
        async ({ agentId, isLocal }) => {
          try {
            const agent = await client.agents.retrieve(agentId, {
              include: ["agent.blocks"],
            });
            // Use agent name from server
            return { name: agent.name, agentId, agent, error: null, isLocal };
          } catch (_err) {
            return {
              name: agentId.slice(0, 12),
              agentId,
              agent: null,
              error: "Agent not found",
              isLocal,
            };
          }
        },
      );

      const profileData = await Promise.all(profileDataPromises);
      setProfiles(profileData);
    } catch (_err) {
      setProfiles([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfiles();
  }, [loadProfiles]);

  // Pagination
  const totalPages = Math.ceil(profiles.length / DISPLAY_PAGE_SIZE);
  const startIndex = currentPage * DISPLAY_PAGE_SIZE;
  const pageProfiles = profiles.slice(
    startIndex,
    startIndex + DISPLAY_PAGE_SIZE,
  );

  // Get currently selected profile
  const selectedProfile = pageProfiles[selectedIndex];

  useInput((input, key) => {
    if (loading) return;

    // Handle delete confirmation mode
    if (mode === "confirming-delete") {
      if (key.upArrow || key.downArrow) {
        setDeleteConfirmIndex((prev) => (prev === 0 ? 1 : 0));
      } else if (key.return) {
        if (deleteConfirmIndex === 0 && selectedProfile) {
          // Yes - unpin (onUnpin closes the selector)
          onUnpin(selectedProfile.agentId);
          return;
        } else {
          // No - cancel
          setMode("browsing");
        }
      } else if (key.escape) {
        setMode("browsing");
      }
      return;
    }

    // Browsing mode
    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(pageProfiles.length - 1, prev + 1));
    } else if (key.return) {
      if (selectedProfile?.agent) {
        onSelect(selectedProfile.agentId);
      }
    } else if (key.escape) {
      onCancel();
    } else if (input === "d" || input === "D") {
      if (selectedProfile) {
        setMode("confirming-delete");
        setDeleteConfirmIndex(1); // Default to "No"
      }
    } else if (input === "j" || input === "J") {
      // Previous page
      if (currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(0);
      }
    } else if (input === "k" || input === "K") {
      // Next page
      if (currentPage < totalPages - 1) {
        setCurrentPage((prev) => prev + 1);
        setSelectedIndex(0);
      }
    } else if (input === "p" || input === "P") {
      if (selectedProfile) {
        // Unpin from current scope
        if (selectedProfile.isLocal) {
          settingsManager.unpinLocal(selectedProfile.agentId);
        } else {
          settingsManager.unpinGlobal(selectedProfile.agentId);
        }
      } else {
        // No profiles - pin the current agent
        settingsManager.pinLocal(currentAgentId);
      }
      // Reload profiles to reflect change
      loadProfiles();
    }
  });

  // Unpin confirmation UI
  if (mode === "confirming-delete" && selectedProfile) {
    const options = ["Yes, unpin", "No, cancel"];
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold color={colors.selector.title}>
            Unpin Agent
          </Text>
        </Box>
        <Box>
          <Text>Unpin "{selectedProfile.name}" from all locations?</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, index) => {
            const isSelected = index === deleteConfirmIndex;
            return (
              <Box key={option}>
                <Text
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                  bold={isSelected}
                >
                  {isSelected ? ">" : " "} {option}
                </Text>
              </Box>
            );
          })}
        </Box>
      </Box>
    );
  }

  // Main browsing UI
  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Text bold color={colors.selector.title}>
          Pinned Agents
        </Text>
      </Box>

      {/* Loading state */}
      {loading && (
        <Box>
          <Text dimColor>Loading pinned agents...</Text>
        </Box>
      )}

      {/* Empty state */}
      {!loading && profiles.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>No agents pinned.</Text>
          <Text dimColor>Press P to pin the current agent.</Text>
          <Box marginTop={1}>
            <Text dimColor>Esc to close</Text>
          </Box>
        </Box>
      )}

      {/* Profile list */}
      {!loading && profiles.length > 0 && (
        <Box flexDirection="column">
          {pageProfiles.map((profile, index) => {
            const isSelected = index === selectedIndex;
            const isCurrent = profile.agentId === currentAgentId;
            const hasAgent = profile.agent !== null;

            // Calculate available width for agent ID
            const nameLen = profile.name.length;
            const fixedChars = 2 + 3 + (isCurrent ? 10 : 0); // "> " + " · " + " (current)"
            const availableForId = Math.max(
              15,
              terminalWidth - nameLen - fixedChars,
            );
            const displayId = truncateAgentId(profile.agentId, availableForId);

            return (
              <Box
                key={profile.agentId}
                flexDirection="column"
                marginBottom={1}
              >
                {/* Row 1: Selection indicator, profile name, and ID */}
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
                    {profile.name}
                  </Text>
                  <Text dimColor>
                    {" "}
                    · {profile.isLocal ? "project" : "global"} · {displayId}
                  </Text>
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Box>
                {/* Row 2: Description or error */}
                <Box flexDirection="row" marginLeft={2}>
                  {hasAgent ? (
                    <Text dimColor italic>
                      {profile.agent?.description || "No description"}
                    </Text>
                  ) : (
                    <Text color="red" italic>
                      {profile.error}
                    </Text>
                  )}
                </Box>
                {/* Row 3: Metadata (only if agent exists) */}
                {hasAgent && profile.agent && (
                  <Box flexDirection="row" marginLeft={2}>
                    <Text dimColor>
                      {formatRelativeTime(profile.agent.last_run_completion)} ·{" "}
                      {profile.agent.blocks?.length ?? 0} memory block
                      {(profile.agent.blocks?.length ?? 0) === 1 ? "" : "s"} ·{" "}
                      {formatModel(profile.agent)}
                    </Text>
                  </Box>
                )}
              </Box>
            );
          })}
        </Box>
      )}

      {/* Footer with pagination and controls */}
      {!loading && profiles.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {totalPages > 1 && (
            <Box>
              <Text dimColor>
                Page {currentPage + 1}/{totalPages}
              </Text>
            </Box>
          )}
          <Box>
            <Text dimColor>
              ↑↓ navigate · Enter load · P unpin · D unpin all · Esc close
            </Text>
          </Box>
        </Box>
      )}

      {/* Footer for empty state already handled above */}
    </Box>
  );
});

ProfileSelector.displayName = "ProfileSelector";
