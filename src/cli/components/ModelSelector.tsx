// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  type ApiModel,
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import { colors } from "./colors";

const PAGE_SIZE = 10;

type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  updateArgs?: Record<string, unknown>;
};

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
  const [currentPage, setCurrentPage] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  // undefined: not loaded yet (show spinner)
  // Set<string>: loaded and filtered
  // null: error fallback (show all models + warning)
  const [availableModels, setAvailableModels] = useState<
    Set<string> | null | undefined
  >(undefined);
  const [apiModels, setApiModels] = useState<ApiModel[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Fetch available models from the API (with caching + inflight dedupe)
  const loadModels = useRef(async (forceRefresh = false) => {
    try {
      if (forceRefresh) {
        clearAvailableModelsCache();
        if (mountedRef.current) {
          setRefreshing(true);
          setError(null);
        }
      }

      const cacheInfoBefore = getAvailableModelsCacheInfo();
      const result = await getAvailableModelHandles({ forceRefresh });

      if (!mountedRef.current) return;

      setAvailableModels(result.handles);
      setApiModels(result.models);
      setIsCached(!forceRefresh && cacheInfoBefore.isFresh);
      setIsLoading(false);
      setRefreshing(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load models");
      setIsLoading(false);
      setRefreshing(false);
      // Fallback: show all models if API fails
      setAvailableModels(null);
      setApiModels([]);
    }
  });

  useEffect(() => {
    loadModels.current(false);
  }, []);

  // Get the set of handles that are in the static models list
  const staticModelHandles = useMemo(
    () => new Set(typedModels.map((m) => m.handle)),
    [typedModels],
  );

  // Filter models based on availability
  const filteredModels = useMemo(() => {
    // Not loaded yet: render nothing (avoid briefly showing unfiltered models)
    if (availableModels === undefined) return [];
    // Error fallback: show all models with warning
    if (availableModels === null) return typedModels;

    // Loaded: filter static models to only show those the user has access to
    const availableStaticModels = typedModels.filter((model) =>
      availableModels.has(model.handle),
    );

    // Also include BYOK/custom models from the API that aren't in the static list
    const byokModels: UiModel[] = apiModels
      .filter((apiModel) => !staticModelHandles.has(apiModel.handle))
      .map((apiModel) => ({
        id: apiModel.handle,
        handle: apiModel.handle,
        label: apiModel.display_name,
        description: `${apiModel.provider_name} (${apiModel.provider_type})`,
        isFeatured: false,
      }));

    return [...availableStaticModels, ...byokModels];
  }, [typedModels, availableModels, apiModels, staticModelHandles]);

  const featuredModels = useMemo(
    () => filteredModels.filter((model) => model.isFeatured),
    [filteredModels],
  );

  const totalPages = useMemo(
    () => Math.ceil(filteredModels.length / PAGE_SIZE),
    [filteredModels.length],
  );

  const visibleModels = useMemo(() => {
    if (showAll) {
      const start = currentPage * PAGE_SIZE;
      return filteredModels.slice(start, start + PAGE_SIZE);
    }
    if (featuredModels.length > 0) return featuredModels;
    return filteredModels.slice(0, 5);
  }, [featuredModels, showAll, filteredModels, currentPage]);

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
      } else if (key.leftArrow && showAll && currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(0);
      } else if (key.rightArrow && showAll && currentPage < totalPages - 1) {
        setCurrentPage((prev) => prev + 1);
        setSelectedIndex(0);
      } else if (key.return) {
        if (hasMoreModels && selectedIndex === visibleModels.length) {
          setShowAll(true);
          setCurrentPage(0);
          setSelectedIndex(0);
        } else {
          const selectedModel = visibleModels[selectedIndex];
          if (selectedModel) {
            onSelect(selectedModel.id);
          }
        }
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Select Model (↑↓ to navigate, Enter to select, ESC to cancel)
        </Text>
        {!isLoading && !refreshing && (
          <Text dimColor>
            {showAll
              ? `Page ${currentPage + 1}/${totalPages} (←→ to navigate pages, 'r' to refresh)`
              : isCached
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
