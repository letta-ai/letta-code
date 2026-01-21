// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

const VISIBLE_ITEMS = 8;

type ModelCategory = "supported" | "all";
const MODEL_CATEGORIES: ModelCategory[] = ["supported", "all"];

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
  currentModelId?: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  /** Filter models to only show those matching this provider prefix (e.g., "chatgpt-plus-pro") */
  filterProvider?: string;
  /** Force refresh the models list on mount */
  forceRefresh?: boolean;
}

export function ModelSelector({
  currentModelId,
  onSelect,
  onCancel,
  filterProvider,
  forceRefresh: forceRefreshOnMount,
}: ModelSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const typedModels = models as UiModel[];
  const [category, setCategory] = useState<ModelCategory>("supported");
  const [selectedIndex, setSelectedIndex] = useState(0);

  // undefined: not loaded yet (show spinner)
  // Set<string>: loaded and filtered
  // null: error fallback (show all models + warning)
  const [availableHandles, setAvailableHandles] = useState<
    Set<string> | null | undefined
  >(undefined);
  const [allApiHandles, setAllApiHandles] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

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

      setAvailableHandles(result.handles);
      setAllApiHandles(Array.from(result.handles));
      setIsCached(!forceRefresh && cacheInfoBefore.isFresh);
      setIsLoading(false);
      setRefreshing(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load models");
      setIsLoading(false);
      setRefreshing(false);
      // Fallback: show all models if API fails
      setAvailableHandles(null);
      setAllApiHandles([]);
    }
  });

  useEffect(() => {
    loadModels.current(forceRefreshOnMount ?? false);
  }, [forceRefreshOnMount]);

  // Handles from models.json (for filtering "all" category)
  const staticModelHandles = useMemo(
    () => new Set(typedModels.map((m) => m.handle)),
    [typedModels],
  );

  // Supported models: models.json entries that are available
  // Featured models first, then non-featured, preserving JSON order within each group
  // If filterProvider is set, only show models from that provider
  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    let available =
      availableHandles === null
        ? typedModels // fallback
        : typedModels.filter((m) => availableHandles.has(m.handle));
    // Apply provider filter if specified
    if (filterProvider) {
      available = available.filter((m) =>
        m.handle.startsWith(`${filterProvider}/`),
      );
    }
    const featured = available.filter((m) => m.isFeatured);
    const nonFeatured = available.filter((m) => !m.isFeatured);
    return [...featured, ...nonFeatured];
  }, [typedModels, availableHandles, filterProvider]);

  // All other models: API handles not in models.json
  const otherModelHandles = useMemo(() => {
    const filtered = allApiHandles.filter(
      (handle) => !staticModelHandles.has(handle),
    );
    if (!searchQuery) return filtered;
    const query = searchQuery.toLowerCase();
    return filtered.filter((handle) => handle.toLowerCase().includes(query));
  }, [allApiHandles, staticModelHandles, searchQuery]);

  // Get the list for current category
  const currentList: UiModel[] = useMemo(() => {
    if (category === "supported") {
      return supportedModels;
    }
    // For "all" category, convert handles to simple UiModel objects
    return otherModelHandles.map((handle) => ({
      id: handle,
      handle,
      label: handle,
      description: "",
    }));
  }, [category, supportedModels, otherModelHandles]);

  // Show 1 fewer item in "all" category because Search line takes space
  const visibleCount = category === "all" ? VISIBLE_ITEMS - 1 : VISIBLE_ITEMS;

  // Scrolling - keep selectedIndex in view
  const startIndex = useMemo(() => {
    // Keep selected item in the visible window
    if (selectedIndex < visibleCount) return 0;
    return Math.min(
      selectedIndex - visibleCount + 1,
      Math.max(0, currentList.length - visibleCount),
    );
  }, [selectedIndex, currentList.length, visibleCount]);

  const visibleModels = useMemo(() => {
    return currentList.slice(startIndex, startIndex + visibleCount);
  }, [currentList, startIndex, visibleCount]);

  const showScrollDown = startIndex + visibleCount < currentList.length;
  const itemsBelow = currentList.length - startIndex - visibleCount;

  // Reset selection when category changes
  const cycleCategory = useCallback(() => {
    setCategory((current) => {
      const idx = MODEL_CATEGORIES.indexOf(current);
      return MODEL_CATEGORIES[
        (idx + 1) % MODEL_CATEGORIES.length
      ] as ModelCategory;
    });
    setSelectedIndex(0);
    setSearchQuery("");
  }, []);

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && currentList.length > 0) {
      const index = currentList.findIndex((m) => m.id === currentModelId);
      if (index >= 0) {
        setSelectedIndex(index);
      }
      initializedRef.current = true;
    }
  }, [currentList, currentModelId]);

  // Clamp selectedIndex when list changes
  useEffect(() => {
    if (selectedIndex >= currentList.length && currentList.length > 0) {
      setSelectedIndex(currentList.length - 1);
    }
  }, [selectedIndex, currentList.length]);

  useInput(
    (input, key) => {
      // CTRL-C: immediately cancel (bypasses search clearing)
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      // Handle ESC: clear search first if active, otherwise cancel
      if (key.escape) {
        if (searchQuery) {
          setSearchQuery("");
          setSelectedIndex(0);
        } else {
          onCancel();
        }
        return;
      }

      // Allow 'r' to refresh even while loading (but not while already refreshing)
      if (input === "r" && !refreshing && !searchQuery) {
        loadModels.current(true);
        return;
      }

      // Tab or left/right arrows to switch categories
      if (key.tab || key.rightArrow) {
        cycleCategory();
        return;
      }

      if (key.leftArrow) {
        // Cycle backwards through categories
        setCategory((current) => {
          const idx = MODEL_CATEGORIES.indexOf(current);
          return MODEL_CATEGORIES[
            idx === 0 ? MODEL_CATEGORIES.length - 1 : idx - 1
          ] as ModelCategory;
        });
        setSelectedIndex(0);
        setSearchQuery("");
        return;
      }

      // Handle backspace for search
      if (key.backspace || key.delete) {
        if (searchQuery) {
          setSearchQuery((prev) => prev.slice(0, -1));
          setSelectedIndex(0);
        }
        return;
      }

      // Disable other inputs while loading
      if (isLoading || refreshing || currentList.length === 0) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(currentList.length - 1, prev + 1));
      } else if (key.return) {
        const selectedModel = currentList[selectedIndex];
        if (selectedModel) {
          onSelect(selectedModel.id);
        }
      } else if (category === "all" && input && input.length === 1) {
        // Capture text input for search (only in "all" category)
        setSearchQuery((prev) => prev + input);
        setSelectedIndex(0);
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  const getCategoryLabel = (cat: ModelCategory) => {
    if (cat === "supported") return `Recommended (${supportedModels.length})`;
    return `All Available (${otherModelHandles.length})`;
  };

  // Render tab bar (matches AgentSelector style)
  const renderTabBar = () => (
    <Box flexDirection="row" gap={2}>
      {MODEL_CATEGORIES.map((cat) => {
        const isActive = cat === category;
        return (
          <Text
            key={cat}
            backgroundColor={
              isActive ? colors.selector.itemHighlighted : undefined
            }
            color={isActive ? "black" : undefined}
            bold={isActive}
          >
            {` ${getCategoryLabel(cat)} `}
          </Text>
        );
      })}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {/* Command header */}
      <Text dimColor>{"> /model"}</Text>
      <Text dimColor>{solidLine}</Text>

      <Box height={1} />

      {/* Title and tabs */}
      <Box flexDirection="column" gap={1} marginBottom={1}>
        <Text bold color={colors.selector.title}>
          Swap your agent's model
        </Text>
        {!isLoading && !refreshing && (
          <Box flexDirection="column" paddingLeft={1}>
            {renderTabBar()}
            {category === "all" && (
              <Text dimColor> Search: {searchQuery || "(type to filter)"}</Text>
            )}
          </Box>
        )}
      </Box>

      {/* Loading states */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Text dimColor>Loading available models...</Text>
        </Box>
      )}

      {refreshing && (
        <Box paddingLeft={2}>
          <Text dimColor>Refreshing models...</Text>
        </Box>
      )}

      {error && (
        <Box paddingLeft={2}>
          <Text color="yellow">
            Warning: Could not fetch available models. Showing all models.
          </Text>
        </Box>
      )}

      {!isLoading && !refreshing && visibleModels.length === 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {category === "supported"
              ? "No supported models available."
              : "No additional models available."}
          </Text>
        </Box>
      )}

      {/* Model list */}
      <Box flexDirection="column">
        {visibleModels.map((model, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === selectedIndex;
          const isCurrent = model.id === currentModelId;

          return (
            <Box key={model.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              <Text
                bold={isSelected}
                color={
                  isSelected
                    ? colors.selector.itemHighlighted
                    : isCurrent
                      ? colors.selector.itemCurrent
                      : undefined
                }
              >
                {model.label}
                {isCurrent && <Text> (current)</Text>}
              </Text>
              {model.description && (
                <Text dimColor> · {model.description}</Text>
              )}
            </Box>
          );
        })}
        {showScrollDown ? (
          <Text dimColor>
            {"  "}↓ {itemsBelow} more below
          </Text>
        ) : currentList.length > visibleCount ? (
          <Text> </Text>
        ) : null}
      </Box>

      {/* Footer */}
      {!isLoading && !refreshing && currentList.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {"  "}
            {currentList.length} models{isCached ? " · cached" : ""} · R to
            refresh
          </Text>
          <Text dimColor>
            {"  "}Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
