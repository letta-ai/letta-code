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
  type: "select" | "new" | "new_with_model" | "exit";
  agentId?: string;
  profileName?: string | null;
  model?: string;
}

const MAX_DISPLAY = 3;
const MAX_VISIBLE_MODELS = 8;
const MODEL_SEARCH_THRESHOLD = 10; // Show search input when more than this many models

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

function getLabel(option: ProfileOption, freshRepoMode?: boolean): string {
  const parts: string[] = [];
  if (option.isLru) parts.push("last used");
  if (option.isLocal) parts.push("pinned");
  else if (!option.isLru && !freshRepoMode) parts.push("global"); // Pinned globally but not locally
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function ProfileSelectionUI({
  lruAgentId,
  externalLoading,
  externalFreshRepoMode,
  failedAgentMessage,
  serverModelsForNewAgent,
  defaultModelHandle,
  serverBaseUrl,
  onComplete,
}: {
  lruAgentId: string | null;
  externalLoading?: boolean;
  externalFreshRepoMode?: boolean;
  failedAgentMessage?: string;
  serverModelsForNewAgent?: string[];
  defaultModelHandle?: string;
  serverBaseUrl?: string;
  onComplete: (result: ProfileSelectionResult) => void;
}) {
  const [options, setOptions] = useState<ProfileOption[]>([]);
  const [internalLoading, setInternalLoading] = useState(true);
  const loading = externalLoading || internalLoading;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // Model selection mode for self-hosted servers
  // Start in model selection mode if serverModelsForNewAgent is provided and no agents to show
  const [selectingModel, setSelectingModel] = useState(
    !!(serverModelsForNewAgent && serverModelsForNewAgent.length > 0),
  );
  const [modelSelectedIndex, setModelSelectedIndex] = useState(0);
  const [modelSearchQuery, setModelSearchQuery] = useState("");

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
            const agent = await client.agents.retrieve(opt.agentId, {
              include: ["agent.blocks"],
            });
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

  // Model selection - filter out legacy models and apply search
  const allServerModels =
    serverModelsForNewAgent?.filter((h) => h !== "letta/letta-free") ?? [];
  const showModelSearch = allServerModels.length > MODEL_SEARCH_THRESHOLD;
  const filteredModels = modelSearchQuery
    ? allServerModels.filter((h) =>
        h.toLowerCase().includes(modelSearchQuery.toLowerCase()),
      )
    : allServerModels;
  const modelCount = filteredModels.length;

  // Model selection scrolling
  const modelStartIndex = Math.max(
    0,
    Math.min(
      modelSelectedIndex - MAX_VISIBLE_MODELS + 1,
      modelCount - MAX_VISIBLE_MODELS,
    ),
  );
  const visibleModels = filteredModels.slice(
    modelStartIndex,
    modelStartIndex + MAX_VISIBLE_MODELS,
  );
  const showModelScrollDown = modelStartIndex + MAX_VISIBLE_MODELS < modelCount;
  const modelsBelow = modelCount - modelStartIndex - MAX_VISIBLE_MODELS;

  useInput((_input, key) => {
    if (loading) return;

    // Model selection mode
    if (selectingModel && serverModelsForNewAgent) {
      if (key.upArrow) {
        setModelSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setModelSelectedIndex((prev) =>
          Math.min(filteredModels.length - 1, prev + 1),
        );
      } else if (key.return) {
        const selected = filteredModels[modelSelectedIndex];
        if (selected) {
          onComplete({ type: "new_with_model", model: selected });
        }
      } else if (key.escape || (key.ctrl && _input === "c")) {
        // Go back to agent selection or exit
        if (options.length > 0) {
          setSelectingModel(false);
          setModelSearchQuery("");
          setModelSelectedIndex(0);
        } else {
          onComplete({ type: "exit" });
        }
      } else if (key.backspace || key.delete) {
        // Handle backspace for search
        if (showModelSearch && modelSearchQuery.length > 0) {
          setModelSearchQuery((prev) => prev.slice(0, -1));
          setModelSelectedIndex(0);
        }
      } else if (
        showModelSearch &&
        _input &&
        _input.length === 1 &&
        !key.ctrl &&
        !key.meta
      ) {
        // Handle typing for search
        setModelSearchQuery((prev) => prev + _input);
        setModelSelectedIndex(0);
      }
      return;
    }

    // Agent selection mode
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
        // "Create new agent" selected
        if (serverModelsForNewAgent && serverModelsForNewAgent.length > 0) {
          // Need to pick a model first
          setSelectingModel(true);
          setModelSelectedIndex(0);
        } else {
          onComplete({ type: "new" });
        }
      }
    } else if (key.escape || (key.ctrl && _input === "c")) {
      onComplete({ type: "exit" });
    }
  });

  const hasLocalDir = settingsManager.hasLocalLettaDir();
  const contextMessage = externalFreshRepoMode
    ? `${options.length} pinned agent${options.length !== 1 ? "s" : ""} available.`
    : hasLocalDir
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

      {failedAgentMessage && (
        <>
          <Text color="yellow">{failedAgentMessage}</Text>
          <Box height={1} />
        </>
      )}

      {loading ? (
        <Text dimColor>Loading pinned agents...</Text>
      ) : selectingModel && serverModelsForNewAgent ? (
        // Model selection mode
        <Box flexDirection="column" gap={1}>
          <Text bold color={colors.selector.title}>
            Select a model
          </Text>
          <Text dimColor>
            The default model ({defaultModelHandle || "unknown"}) is not
            available on this server.
          </Text>

          {showModelSearch && (
            <Box>
              <Text dimColor>Search: </Text>
              <Text>{modelSearchQuery || ""}</Text>
              <Text dimColor>█</Text>
            </Box>
          )}

          {allServerModels.length === 0 ? (
            <Box flexDirection="column">
              <Text color="yellow">No models found on server.</Text>
              <Text dimColor>Server: {serverBaseUrl || "unknown"}</Text>
              <Text dimColor>
                Did you remember to start the server with your LLM API keys?
              </Text>
            </Box>
          ) : filteredModels.length === 0 ? (
            <Text dimColor>No models matching "{modelSearchQuery}"</Text>
          ) : (
            <Box flexDirection="column">
              {visibleModels.map((handle, index) => {
                const actualIndex = modelStartIndex + index;
                const isSelected = actualIndex === modelSelectedIndex;
                return (
                  <Box key={handle}>
                    <Text
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isSelected ? "> " : "  "}
                      {handle}
                    </Text>
                  </Box>
                );
              })}
              {/* Phantom space or scroll indicator - always reserve the line */}
              {showModelScrollDown ? (
                <Text dimColor> ↓ {modelsBelow} more</Text>
              ) : modelCount > MAX_VISIBLE_MODELS ? (
                <Text> </Text>
              ) : null}
            </Box>
          )}

          <Box>
            <Text dimColor>
              ↑↓ navigate · Enter select
              {showModelSearch ? " · Type to search" : ""} · Esc{" "}
              {options.length > 0 ? "back" : "exit"}
            </Text>
          </Box>
        </Box>
      ) : (
        // Agent selection mode
        <Box flexDirection="column" gap={1}>
          <Text dimColor>{contextMessage}</Text>
          {options.length > 0 && (
            <Text bold>Which agent would you like to use?</Text>
          )}

          <Box flexDirection="column" gap={1}>
            {displayOptions.map((option, index) => {
              const isSelected = index === selectedIndex;
              const displayName =
                option.agent?.name || option.agentId.slice(0, 20);
              const label = getLabel(option, externalFreshRepoMode);

              return (
                <Box key={option.agentId} flexDirection="column">
                  <Box>
                    <Text
                      color={
                        isSelected ? colors.selector.itemHighlighted : undefined
                      }
                    >
                      {isSelected ? "> " : "  "}
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
                  {selectedIndex === displayOptions.length ? "> " : "  "}
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
                {selectedIndex === totalItems - 1 ? "> " : "  "}
                Create a new agent
              </Text>
              <Text dimColor> (--new)</Text>
            </Box>
          </Box>

          <Box>
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
  freshRepoMode,
  failedAgentMessage,
  serverModelsForNewAgent,
  defaultModelHandle,
  serverBaseUrl,
  onSelect,
  onCreateNew,
  onCreateNewWithModel,
  onExit,
}: {
  lruAgentId: string | null;
  loading?: boolean;
  freshRepoMode?: boolean;
  failedAgentMessage?: string;
  /** If provided, show model selector when user clicks "Create new" */
  serverModelsForNewAgent?: string[];
  /** The default model handle that wasn't available */
  defaultModelHandle?: string;
  /** The server base URL for error messages */
  serverBaseUrl?: string;
  onSelect: (agentId: string) => void;
  onCreateNew: () => void;
  /** Called when user selects a model from serverModelsForNewAgent */
  onCreateNewWithModel?: (model: string) => void;
  onExit: () => void;
}) {
  const handleComplete = (result: ProfileSelectionResult) => {
    if (result.type === "exit") {
      onExit();
    } else if (result.type === "select" && result.agentId) {
      onSelect(result.agentId);
    } else if (result.type === "new_with_model" && result.model) {
      onCreateNewWithModel?.(result.model);
    } else {
      onCreateNew();
    }
  };

  return React.createElement(ProfileSelectionUI, {
    lruAgentId,
    externalLoading,
    externalFreshRepoMode: freshRepoMode,
    failedAgentMessage,
    serverModelsForNewAgent,
    defaultModelHandle,
    serverBaseUrl,
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
