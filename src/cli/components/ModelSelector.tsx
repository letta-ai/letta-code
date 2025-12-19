// Import useInput from vendored Ink for bracketed paste support
import { Box, Text, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import { colors } from "./colors";

const PAGE_SIZE = 10;

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
}

export function ModelSelector({
  currentModelId,
  onSelect,
  onCancel,
}: ModelSelectorProps) {
  const typedModels = models as UiModel[];
  const [category, setCategory] = useState<ModelCategory>("supported");
  const [currentPage, setCurrentPage] = useState(0);
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
    loadModels.current(false);
  }, []);

  // Handles from models.json (for filtering "all" category)
  const staticModelHandles = useMemo(
    () => new Set(typedModels.map((m) => m.handle)),
    [typedModels],
  );

  // Supported models: models.json entries that are available
  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    if (availableHandles === null) return typedModels; // fallback
    return typedModels.filter((m) => availableHandles.has(m.handle));
  }, [typedModels, availableHandles]);

  // All other models: API handles not in models.json
  const otherModelHandles = useMemo(() => {
    const filtered = allApiHandles.filter((handle) => !staticModelHandles.has(handle));
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

  // Pagination
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(currentList.length / PAGE_SIZE)),
    [currentList.length],
  );

  const visibleModels = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    return currentList.slice(start, start + PAGE_SIZE);
  }, [currentList, currentPage]);

  // Reset page and selection when category changes
  const cycleCategory = useCallback(() => {
    setCategory((current) => {
      const idx = MODEL_CATEGORIES.indexOf(current);
      return MODEL_CATEGORIES[
        (idx + 1) % MODEL_CATEGORIES.length
      ] as ModelCategory;
    });
    setCurrentPage(0);
    setSelectedIndex(0);
    setSearchQuery("");
  }, []);

  // Set initial selection to current model on mount
  const initializedRef = useRef(false);
  useEffect(() => {
    if (!initializedRef.current && visibleModels.length > 0) {
      const index = visibleModels.findIndex((m) => m.id === currentModelId);
      if (index >= 0) {
        setSelectedIndex(index);
      }
      initializedRef.current = true;
    }
  }, [visibleModels, currentModelId]);

  // Clamp selectedIndex when list changes
  useEffect(() => {
    if (selectedIndex >= visibleModels.length && visibleModels.length > 0) {
      setSelectedIndex(visibleModels.length - 1);
    }
  }, [selectedIndex, visibleModels.length]);

  useInput(
    (input, key) => {
      // Handle ESC: clear search first if active, otherwise cancel
      if (key.escape) {
        if (searchQuery) {
          setSearchQuery("");
          setCurrentPage(0);
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

      if (key.tab) {
        cycleCategory();
        return;
      }

      // Handle backspace for search
      if (key.backspace || key.delete) {
        if (searchQuery) {
          setSearchQuery((prev) => prev.slice(0, -1));
          setCurrentPage(0);
          setSelectedIndex(0);
        }
        return;
      }

      // Disable other inputs while loading
      if (isLoading || refreshing || visibleModels.length === 0) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) =>
          Math.min(visibleModels.length - 1, prev + 1),
        );
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
      } else if (key.leftArrow && currentPage > 0) {
        setCurrentPage((prev) => prev - 1);
        setSelectedIndex(0);
      } else if (key.rightArrow && currentPage < totalPages - 1) {
        setCurrentPage((prev) => prev + 1);
        setSelectedIndex(0);
      } else if (key.return) {
        const selectedModel = visibleModels[selectedIndex];
        if (selectedModel) {
          onSelect(selectedModel.id);
        }
      } else if (category === "all" && input && input.length === 1) {
        // Capture text input for search (only in "all" category)
        setSearchQuery((prev) => prev + input);
        setCurrentPage(0);
        setSelectedIndex(0);
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  const getCategoryLabel = (cat: ModelCategory) => {
    if (cat === "supported") return `Supported (${supportedModels.length})`;
    return `All Available Models (${otherModelHandles.length})`;
  };

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column">
        <Text bold color={colors.selector.title}>
          Select Model (↑↓ navigate, ←→/jk page, Tab category, Enter select, ESC cancel)
        </Text>
        {!isLoading && !refreshing && (
          <Box>
            <Text dimColor>Category: </Text>
            {MODEL_CATEGORIES.map((cat, i) => (
              <Text key={cat}>
                {i > 0 && <Text dimColor> · </Text>}
                <Text
                  bold={cat === category}
                  color={
                    cat === category
                      ? colors.selector.itemHighlighted
                      : undefined
                  }
                >
                  {getCategoryLabel(cat)}
                </Text>
              </Text>
            ))}
            <Text dimColor> (Tab to switch)</Text>
          </Box>
        )}
        {!isLoading && !refreshing && (
          <Box flexDirection="column">
            <Text dimColor>
              Page {currentPage + 1}/{totalPages}
              {isCached ? " · cached" : ""} · 'r' to refresh
            </Text>
            {category === "all" && (
              <Text dimColor>
                Search: {searchQuery || "(type to search)"}
              </Text>
            )}
          </Box>
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

      {!isLoading && !refreshing && visibleModels.length === 0 && (
        <Box>
          <Text dimColor>
            {category === "supported"
              ? "No supported models available."
              : "No additional models available."}
          </Text>
        </Box>
      )}

      <Box flexDirection="column">
        {visibleModels.map((model, index) => {
          const isSelected = index === selectedIndex;
          const isCurrent = model.id === currentModelId;

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
                {model.description && (
                  <Text dimColor> {model.description}</Text>
                )}
              </Box>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
