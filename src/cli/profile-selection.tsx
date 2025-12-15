/**
 * Profile selection flow - runs before main app starts
 * Similar pattern to auth/setup.ts
 */

import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { Box, Text, useInput } from "ink";
import React, { useCallback, useEffect, useState } from "react";
import { getClient } from "../agent/client";
import { settingsManager } from "../settings-manager";
import { colors } from "./components/colors";
import { WelcomeScreen } from "./components/WelcomeScreen";

interface ProfileOption {
  name: string | null;
  agentId: string;
  isLocal: boolean;
  isLru: boolean;
  agent: AgentState | null;
}

interface ProfileSelectionResult {
  type: "select" | "new" | "exit";
  agentId?: string;
  profileName?: string | null;
}

const MAX_DISPLAY = 3;

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "Just now";
  if (diffMins < 60)
    return `${diffMins} minute${diffMins === 1 ? "" : "s"} ago`;
  if (diffHours < 24)
    return `${diffHours} hour${diffHours === 1 ? "" : "s"} ago`;
  if (diffDays < 7) return `${diffDays} day${diffDays === 1 ? "" : "s"} ago`;
  return `${Math.floor(diffDays / 7)} week${Math.floor(diffDays / 7) === 1 ? "" : "s"} ago`;
}

function formatModel(agent: AgentState): string {
  if (agent.model) {
    const parts = agent.model.split("/");
    return parts[parts.length - 1] || agent.model;
  }
  return agent.llm_config?.model || "unknown";
}

function getLabel(option: ProfileOption): string {
  const parts: string[] = [];
  if (option.isLru) parts.push("last used");
  if (option.isLocal) parts.push("pinned");
  else if (!option.isLru) parts.push("global"); // Pinned globally but not locally
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function ProfileSelectionUI({
  lruAgentId,
  externalLoading,
  onComplete,
}: {
  lruAgentId: string | null;
  externalLoading?: boolean;
  onComplete: (result: ProfileSelectionResult) => void;
}) {
  const [options, setOptions] = useState<ProfileOption[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const loading = externalLoading || internalLoading;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);

  const loadOptions = useCallback(async () => {
    setInternalLoading(true);
    try {
      const mergedPinned = settingsManager.getMergedPinnedAgents();
      const client = await getClient();

      const optionsToFetch: ProfileOption[] = [];
      const seenAgentIds = new Set<string>();

      // First: LRU agent
      if (lruAgentId) {
        const matchingPinned = mergedPinned.find(
          (p) => p.agentId === lruAgentId,
        );
        optionsToFetch.push({
          name: null, // Will be fetched from server
          agentId: lruAgentId,
          isLocal: matchingPinned?.isLocal || false,
          isLru: true,
          agent: null,
        });
        seenAgentIds.add(lruAgentId);
      }

      // Then: Other pinned agents
      for (const pinned of mergedPinned) {
        if (!seenAgentIds.has(pinned.agentId)) {
          optionsToFetch.push({
            name: null, // Will be fetched from server
            agentId: pinned.agentId,
            isLocal: pinned.isLocal,
            isLru: false,
            agent: null,
          });
          seenAgentIds.add(pinned.agentId);
        }
      }

      // Fetch agent data
      const fetchedOptions = await Promise.all(
        optionsToFetch.map(async (opt) => {
          try {
            const agent = await client.agents.retrieve(opt.agentId);
            return { ...opt, agent };
          } catch {
            return { ...opt, agent: null };
          }
        }),
      );

      setOptions(fetchedOptions.filter((opt) => opt.agent !== null));
    } catch {
      setOptions([]);
    } finally {
      setInternalLoading(false);
    }
  }, [lruAgentId]);

  useEffect(() => {
    loadOptions();
  }, [loadOptions]);

  const displayOptions = showAll ? options : options.slice(0, MAX_DISPLAY);
  const hasMore = options.length > MAX_DISPLAY;
  const totalItems = displayOptions.length + 1 + (hasMore && !showAll ? 1 : 0);

  useInput((_input, key) => {
    if (loading) return;

    if (key.upArrow) {
      setSelectedIndex((prev) => Math.max(0, prev - 1));
    } else if (key.downArrow) {
      setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
    } else if (key.return) {
      if (selectedIndex < displayOptions.length) {
        const selected = displayOptions[selectedIndex];
        if (selected) {
          onComplete({
            type: "select",
            agentId: selected.agentId,
            profileName: selected.name,
          });
        }
      } else if (
        hasMore &&
        !showAll &&
        selectedIndex === displayOptions.length
      ) {
        setShowAll(true);
        setSelectedIndex(0);
      } else {
        onComplete({ type: "new" });
      }
    } else if (key.escape) {
      onComplete({ type: "exit" });
    }
  });

  const hasLocalDir = settingsManager.hasLocalLettaDir();
  const contextMessage = hasLocalDir
    ? "Existing `.letta` folder detected."
    : `${options.length} agent profile${options.length !== 1 ? "s" : ""} detected.`;

  return (
    <Box flexDirection="column">
      {/* Welcome Screen */}
      <WelcomeScreen
        loadingState="ready"
        continueSession={false}
        agentState={null}
        agentProvenance={null}
      />
      <Box height={1} />

      {loading ? (
        <Text dimColor>Loading profiles...</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{contextMessage}</Text>
          <Text bold>Which agent would you like to use?</Text>

          <Box flexDirection="column" gap={1}>
            {displayOptions.map((option, index) => {
              const isSelected = index === selectedIndex;
              const displayName =
                option.agent?.name || option.agentId.slice(0, 20);
              const label = getLabel(option);

              return (
                <Box key={option.agentId} flexDirection="column">
                  <Box>
                    <Text
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isSelected ? "→ " : "  "}
                    </Text>
                    <Text
                      bold={isSelected}
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      Resume{" "}
                    </Text>
                    <Text
                      bold
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {displayName}
                    </Text>
                    <Text dimColor>{label}</Text>
                  </Box>
                  {option.agent && (
                    <Box marginLeft={4}>
                      <Text dimColor>
                        {formatRelativeTime(option.agent.last_run_completion)} ·{" "}
                        {option.agent.memory?.blocks?.length || 0} memory blocks
                        · {formatModel(option.agent)}
                      </Text>
                    </Box>
                  )}
                </Box>
              );
            })}

            {hasMore && !showAll && (
              <Box>
                <Text
                  color={
                    selectedIndex === displayOptions.length
                      ? colors.selector.itemHighlighted
                      : undefined
                  }
                >
                  {selectedIndex === displayOptions.length ? "→ " : "  "}
                  View all {options.length} profiles
                </Text>
              </Box>
            )}

            <Box>
              <Text
                color={
                  selectedIndex === totalItems - 1
                    ? colors.selector.itemHighlighted
                    : undefined
                }
              >
                {selectedIndex === totalItems - 1 ? "→ " : "  "}
                Create a new agent
              </Text>
              <Text dimColor> (--new)</Text>
            </Box>
          </Box>

          <Box marginTop={1}>
            <Text dimColor>↑↓ navigate · Enter select · Esc exit</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}

/**
 * Inline profile selection component - used within LoadingApp
 */
export function ProfileSelectionInline({
  lruAgentId,
  loading: externalLoading,
  onSelect,
  onCreateNew,
  onExit,
}: {
  lruAgentId: string | null;
  loading?: boolean;
  onSelect: (agentId: string) => void;
  onCreateNew: () => void;
  onExit: () => void;
}) {
  const handleComplete = (result: ProfileSelectionResult) => {
    if (result.type === "exit") {
      onExit();
    } else if (result.type === "select" && result.agentId) {
      onSelect(result.agentId);
    } else {
      onCreateNew();
    }
  };

  return React.createElement(ProfileSelectionUI, {
    lruAgentId,
    externalLoading,
    onComplete: handleComplete,
  });
}

/**
 * Check if profile selection is needed
 */
export async function shouldShowProfileSelection(
  forceNew: boolean,
  agentIdArg: string | null,
  fromAfFile: string | undefined,
): Promise<{ show: boolean; lruAgentId: string | null }> {
  // Skip for explicit flags
  if (forceNew || agentIdArg || fromAfFile) {
    return { show: false, lruAgentId: null };
  }

  // Load settings
  await settingsManager.loadLocalProjectSettings();
  const localSettings = settingsManager.getLocalProjectSettings();
  const globalProfiles = settingsManager.getGlobalProfiles();
  const localProfiles = localSettings.profiles || {};

  const hasProfiles =
    Object.keys(globalProfiles).length > 0 ||
    Object.keys(localProfiles).length > 0;
  const lru = localSettings.lastAgent || null;

  // Show selector if there are choices
  return {
    show: hasProfiles || !!lru,
    lruAgentId: lru,
  };
}
