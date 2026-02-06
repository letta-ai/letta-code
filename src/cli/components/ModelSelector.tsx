// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import { useTerminalWidth } from "../hooks/useTerminalWidth";
import { colors } from "./colors";
import { Text } from "./Text";

// Horizontal line character (matches approval dialogs)
const SOLID_LINE = "─";

const VISIBLE_ITEMS = 8;

type ModelCategory =
  | "supported"
  | "byok"
  | "byok-all"
  | "all"
  | "server-recommended"
  | "server-all";

// BYOK provider prefixes (ChatGPT OAuth + lc-* providers from /connect)
const BYOK_PROVIDER_PREFIXES = ["chatgpt-plus-pro/", "lc-"];

// Get tab order based on billing tier (free = BYOK first, paid = BYOK last)
// For self-hosted servers, only show server-specific tabs
function getModelCategories(
  billingTier?: string,
  isSelfHosted?: boolean,
): ModelCategory[] {
  if (isSelfHosted) {
    return ["server-recommended", "server-all"];
  }
  const isFreeTier = billingTier?.toLowerCase() === "free";
  return isFreeTier
    ? ["byok", "byok-all", "supported", "all"]
    : ["supported", "all", "byok", "byok-all"];
}

type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
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
  /** User's billing tier - affects tab ordering (free = BYOK first) */
  billingTier?: string;
  /** Whether connected to a self-hosted server (not api.letta.com) */
  isSelfHosted?: boolean;
}

export function ModelSelector({
  currentModelId,
  onSelect,
  onCancel,
  filterProvider,
  forceRefresh: forceRefreshOnMount,
  billingTier,
  isSelfHosted,
}: ModelSelectorProps) {
  const terminalWidth = useTerminalWidth();
  const solidLine = SOLID_LINE.repeat(Math.max(terminalWidth, 10));
  const typedModels = models as UiModel[];

  // Tab order depends on billing tier (free = BYOK first)
  // For self-hosted, only show server-specific tabs
  const modelCategories = useMemo(
    () => getModelCategories(billingTier, isSelfHosted),
    [billingTier, isSelfHosted],
  );
  const defaultCategory = modelCategories[0] ?? "supported";

  const [category, setCategory] = useState<ModelCategory>(defaultCategory);
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
  // For free tier, free models go first
  const isFreeTier = billingTier?.toLowerCase() === "free";
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
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

    // For free tier, put free models first, then others with standard ordering
    if (isFreeTier) {
      const freeModels = available.filter((m) => m.free);
      const paidModels = available.filter((m) => !m.free);
      const featured = paidModels.filter((m) => m.isFeatured);
      const nonFeatured = paidModels.filter((m) => !m.isFeatured);
      return [...freeModels, ...featured, ...nonFeatured];
    }

    const featured = available.filter((m) => m.isFeatured);
    const nonFeatured = available.filter((m) => !m.isFeatured);
    return [...featured, ...nonFeatured];
  }, [typedModels, availableHandles, filterProvider, searchQuery, isFreeTier]);

  // BYOK models: models from chatgpt-plus-pro or lc-* providers
  const isByokHandle = useCallback(
    (handle: string) =>
      BYOK_PROVIDER_PREFIXES.some((prefix) => handle.startsWith(prefix)),
    [],
  );

  // All other models: API handles not in models.json and not BYOK
  const otherModelHandles = useMemo(() => {
    const filtered = allApiHandles.filter(
      (handle) => !staticModelHandles.has(handle) && !isByokHandle(handle),
    );
    if (!searchQuery) return filtered;
    const query = searchQuery.toLowerCase();
    return filtered.filter((handle) => handle.toLowerCase().includes(query));
  }, [allApiHandles, staticModelHandles, searchQuery, isByokHandle]);

  // Provider name mappings for BYOK -> models.json lookup
  // Maps BYOK provider prefix to models.json provider prefix
  const BYOK_PROVIDER_ALIASES: Record<string, string> = {
    "lc-anthropic": "anthropic",
    "lc-openai": "openai",
    "lc-zai": "zai",
    "lc-gemini": "google_ai",
    "chatgpt-plus-pro": "chatgpt-plus-pro", // No change needed
  };

  // Convert BYOK handle to base provider handle for models.json lookup
  // e.g., "lc-anthropic/claude-3-5-haiku" -> "anthropic/claude-3-5-haiku"
  // e.g., "lc-gemini/gemini-2.0-flash" -> "google_ai/gemini-2.0-flash"
  const toBaseHandle = useCallback((handle: string): string => {
    const slashIndex = handle.indexOf("/");
    if (slashIndex === -1) return handle;

    const provider = handle.slice(0, slashIndex);
    const model = handle.slice(slashIndex + 1);
    const baseProvider = BYOK_PROVIDER_ALIASES[provider];

    if (baseProvider) {
      return `${baseProvider}/${model}`;
    }
    return handle;
  }, []);

  // BYOK (recommended): BYOK API handles that have matching entries in models.json
  const byokModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    // Get all BYOK handles from API
    const byokHandles = allApiHandles.filter(isByokHandle);

    // Find models.json entries that match (using alias for lc-* providers)
    const matched: UiModel[] = [];
    for (const handle of byokHandles) {
      const baseHandle = toBaseHandle(handle);
      const staticModel = typedModels.find((m) => m.handle === baseHandle);
      if (staticModel) {
        // Use models.json data but with the BYOK handle as the ID
        matched.push({
          ...staticModel,
          id: handle,
          handle: handle,
        });
      }
    }

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return matched.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

    return matched;
  }, [
    availableHandles,
    allApiHandles,
    typedModels,
    searchQuery,
    isByokHandle,
    toBaseHandle,
  ]);

  // BYOK (all): BYOK handles from API that don't have matching models.json entries
  const byokAllModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    // Get BYOK handles that don't have a match in models.json (using alias)
    const byokHandles = allApiHandles.filter((handle) => {
      if (!isByokHandle(handle)) return false;
      const baseHandle = toBaseHandle(handle);
      // Exclude if there's a matching entry in models.json
      return !staticModelHandles.has(baseHandle);
    });

    // Apply search filter
    let filtered = byokHandles;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = byokHandles.filter((handle) =>
        handle.toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [
    availableHandles,
    allApiHandles,
    staticModelHandles,
    searchQuery,
    isByokHandle,
    toBaseHandle,
  ]);

  // Server-recommended models: models.json entries available on the server (for self-hosted)
  // Filter out letta/letta-free legacy model
  const serverRecommendedModels = useMemo(() => {
    if (!isSelfHosted || availableHandles === undefined) return [];
    const available = typedModels.filter(
      (m) => availableHandles?.has(m.handle) && m.handle !== "letta/letta-free",
    );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      return available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }
    return available;
  }, [isSelfHosted, typedModels, availableHandles, searchQuery]);

  // Server-all models: ALL handles from the server (for self-hosted)
  // Filter out letta/letta-free legacy model
  const serverAllModels = useMemo(() => {
    if (!isSelfHosted) return [];
    let handles = allApiHandles.filter((h) => h !== "letta/letta-free");
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      handles = handles.filter((h) => h.toLowerCase().includes(query));
    }
    return handles;
  }, [isSelfHosted, allApiHandles, searchQuery]);

  // Get the list for current category
  const currentList: UiModel[] = useMemo(() => {
    if (category === "supported") {
      return supportedModels;
    }
    if (category === "byok") {
      return byokModels;
    }
    if (category === "byok-all") {
      // Convert raw handles to UiModel
      return byokAllModels.map((handle) => ({
        id: handle,
        handle,
        label: handle,
        description: "",
      }));
    }
    if (category === "server-recommended") {
      return serverRecommendedModels;
    }
    if (category === "server-all") {
      // Convert raw handles to UiModel
      return serverAllModels.map((handle) => ({
        id: handle,
        handle,
        label: handle,
        description: "",
      }));
    }
    // For "all" category, convert handles to simple UiModel objects
    return otherModelHandles.map((handle) => ({
      id: handle,
      handle,
      label: handle,
      description: "",
    }));
  }, [
    category,
    supportedModels,
    byokModels,
    byokAllModels,
    otherModelHandles,
    serverRecommendedModels,
    serverAllModels,
  ]);

  // Show 1 fewer item because Search line takes space
  const visibleCount = VISIBLE_ITEMS - 1;

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
      const idx = modelCategories.indexOf(current);
      return modelCategories[
        (idx + 1) % modelCategories.length
      ] as ModelCategory;
    });
    setSelectedIndex(0);
    setSearchQuery("");
  }, [modelCategories]);

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
          const idx = modelCategories.indexOf(current);
          return modelCategories[
            idx === 0 ? modelCategories.length - 1 : idx - 1
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

      // Capture text input for search (allow typing even with 0 results)
      // Exclude special keys like Enter, arrows, etc.
      if (
        input &&
        input.length === 1 &&
        !key.ctrl &&
        !key.meta &&
        !key.return &&
        !key.upArrow &&
        !key.downArrow
      ) {
        setSearchQuery((prev) => prev + input);
        setSelectedIndex(0);
        return;
      }

      // Disable navigation/selection while loading or no results
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
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  const getCategoryLabel = (cat: ModelCategory) => {
    if (cat === "supported") return `Letta API [${supportedModels.length}]`;
    if (cat === "byok") return `BYOK [${byokModels.length}]`;
    if (cat === "byok-all") return `BYOK (all) [${byokAllModels.length}]`;
    if (cat === "server-recommended")
      return `Recommended [${serverRecommendedModels.length}]`;
    if (cat === "server-all") return `All models [${serverAllModels.length}]`;
    return `Letta API (all) [${otherModelHandles.length}]`;
  };

  const getCategoryDescription = (cat: ModelCategory) => {
    if (cat === "server-recommended") {
      return "Recommended models on the server";
    }
    if (cat === "server-all") {
      return "All models on the server";
    }
    if (cat === "supported") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "Recommended models on the Letta API";
    }
    if (cat === "byok")
      return "Recommended models via your API keys (use /connect to add more)";
    if (cat === "byok-all")
      return "All models via your API keys (use /connect to add more)";
    if (cat === "all") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "All models on the Letta API";
    }
    return "All models on the Letta API";
  };

  // Render tab bar (matches AgentSelector style)
  const renderTabBar = () => (
    <Box flexDirection="row" gap={2}>
      {modelCategories.map((cat) => {
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
            <Text dimColor> {getCategoryDescription(category)}</Text>
            <Text>
              <Text dimColor> Search: </Text>
              {searchQuery ? (
                <Text>{searchQuery}</Text>
              ) : (
                <Text dimColor>(type to filter)</Text>
              )}
            </Text>
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
          // Show lock for non-free models when on free tier (only for Letta API tabs)
          const showLock =
            isFreeTier &&
            !model.free &&
            (category === "supported" || category === "all");

          return (
            <Box key={model.id} flexDirection="row">
              <Text
                color={isSelected ? colors.selector.itemHighlighted : undefined}
              >
                {isSelected ? "> " : "  "}
              </Text>
              {showLock && <Text dimColor>🔒 </Text>}
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
