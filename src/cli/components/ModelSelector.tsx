// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { getClient } from "../../agent/client";
import { models } from "../../agent/model";
import { colors } from "./colors";

type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  updateArgs?: Record<string, unknown>;
};

// Cache for available models with 5 minute TTL
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let modelsCache: {
  data: Set<string>;
  timestamp: number;
} | null = null;

/**
 * Fetch available models from the API with caching
 */
async function fetchAvailableModelsWithCache(): Promise<Set<string>> {
  const now = Date.now();

  // Return cached data if still valid
  if (modelsCache && now - modelsCache.timestamp < CACHE_TTL_MS) {
    return modelsCache.data;
  }

  // Fetch fresh data
  const client = await getClient();
  const modelsList = await client.models.list();

  // Create a set of available model handles for fast lookup
  const availableHandles = new Set(
    modelsList.map((m) => m.handle).filter((h): h is string => !!h),
  );

  // Update cache
  modelsCache = {
    data: availableHandles,
    timestamp: now,
  };

  return availableHandles;
}

/**
 * Clear the models cache (useful for forcing a refresh)
 */
export function clearModelsCache(): void {
  modelsCache = null;
}

interface ModelSelectorProps {
  currentModel?: string;
  currentEnableReasoner?: boolean;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

export function ModelSelector({
  currentModel,
  currentEnableReasoner,
  onSelect,
  onCancel,
}: ModelSelectorProps) {
  const typedModels = models as UiModel[];
  const [showAll, setShowAll] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [availableModels, setAvailableModels] = useState<Set<string> | null>(
    null,
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Fetch available models from the API (with caching)
  const loadModels = useRef(async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        clearModelsCache();
        setRefreshing(true);
        setError(null);
      }

      const now = Date.now();
      const wasCached =
        modelsCache !== null && now - modelsCache.timestamp < CACHE_TTL_MS;

      const availableHandles = await fetchAvailableModelsWithCache();

      setAvailableModels(availableHandles);
      setIsCached(!forceRefresh && wasCached);
      setIsLoading(false);
      setRefreshing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load models");
      setIsLoading(false);
      setRefreshing(false);
      // Fallback: show all models if API fails
      setAvailableModels(null);
    }
  });

  useEffect(() => {
    loadModels.current(false);
  }, []);

  // Filter models based on availability
  const filteredModels = useMemo(() => {
    // If loading or error (with fallback), show all models
    if (availableModels === null) {
      return typedModels;
    }

    // Filter to only show models the user has access to
    return typedModels.filter((model) => availableModels.has(model.handle));
  }, [typedModels, availableModels]);

  const featuredModels = useMemo(
    () => filteredModels.filter((model) => model.isFeatured),
    [filteredModels],
  );

  const visibleModels = useMemo(() => {
    if (showAll) return filteredModels;
    if (featuredModels.length > 0) return featuredModels;
    return filteredModels.slice(0, 5);
  }, [featuredModels, showAll, filteredModels]);

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current) {
      const index = visibleModels.findIndex((m) => m.handle === currentModel);
      if (index >= 0) {
        setSelectedIndex(index);
      }
      initializedRef.current = true;
    }
  }, [visibleModels, currentModel]);

  const hasMoreModels =
    !showAll && filteredModels.length > visibleModels.length;
  const totalItems = hasMoreModels
    ? visibleModels.length + 1
    : visibleModels.length;

  useInput(
    (input, key) => {
      // Allow ESC even while loading
      if (key.escape) {
        onCancel();
        return;
      }

      // Allow 'r' to refresh even while loading (but not while already refreshing)
      if (input === "r" && !refreshing) {
        loadModels.current(true);
        return;
      }

      // Disable other inputs while loading
      if (isLoading || refreshing || visibleModels.length === 0) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(totalItems - 1, prev + 1));
      } else if (key.return) {
        if (hasMoreModels && selectedIndex === visibleModels.length) {
          setShowAll(true);
          setSelectedIndex(0);
        } else {
          const selectedModel = visibleModels[selectedIndex];
          if (selectedModel) {
            onSelect(selectedModel.id);
          }
        }
      }
    },
    { isActive: !isLoading && !refreshing },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Select Model (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
        {!isLoading && !refreshing && (
          <Text dimColor>
            {isCached
              ? "Cached models (press 'r' to refresh)"
              : "Press 'r' to refresh"}
          </Text>
        )}
      </Box>

      {isLoading && (
        <Box>
          <Text dimColor>Loading available models...</Text>
        </Box>
      )}

      {refreshing && (
        <Box>
          <Text dimColor>Refreshing models...</Text>
        </Box>
      )}

      {error && (
        <Box>
          <Text color="yellow">
            Warning: Could not fetch available models. Showing all models.
          </Text>
        </Box>
      )}

      {!isLoading && visibleModels.length === 0 && (
        <Box>
          <Text color="red">
            No models available. Please check your Letta configuration.
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {visibleModels.map((model, index) => {
          const isSelected = index === selectedIndex;

          // Check if this model is current by comparing handle and relevant settings
          let isCurrent = model.handle === currentModel;

          // For models with the same handle, also check specific configuration settings
          if (isCurrent && model.handle?.startsWith("anthropic/")) {
            // For Anthropic models, check enable_reasoner setting
            const modelEnableReasoner = model.updateArgs?.enable_reasoner;

            // If the model explicitly sets enable_reasoner, check if it matches current settings
            if (modelEnableReasoner !== undefined) {
              // Model has explicit enable_reasoner setting, compare with current
              isCurrent =
                isCurrent && modelEnableReasoner === currentEnableReasoner;
            } else {
              // If model doesn't explicitly set enable_reasoner, it defaults to enabled (or undefined)
              // It's current if currentEnableReasoner is not explicitly false
              isCurrent = isCurrent && currentEnableReasoner !== false;
            }
          }

          return (
            <Box key={model.id} flexDirection="row" gap={1}>
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "›" : " "}
              </Text>
              <Box flexDirection="row">
                <Text
                  bold={isSelected}
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
                >
                  {model.label}
                  {isCurrent && (
                    <Text color={colors.selector.itemCurrent}> (current)</Text>
                  )}
                </Text>
                <Text dimColor> {model.description}</Text>
              </Box>
            </Box>
          );
        })}
        {!showAll && filteredModels.length > visibleModels.length && (
          <Box flexDirection="row" gap={1}>
            <Text
              color={
                selectedIndex === visibleModels.length
                  ? colors.selector.itemHighlighted
                  : undefined
              }
            >
              {selectedIndex === visibleModels.length ? "›" : " "}
            </Text>
            <Text dimColor>
              Show all models ({filteredModels.length} available)
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
}
