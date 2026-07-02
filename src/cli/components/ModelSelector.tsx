// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
  getCachedModelHandles,
  getCachedModelProviderTypes,
} from "@/agent/available-models";
import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  getLocalModelLabel,
  getModelInfo,
  isLocalModelHandle,
  models,
  normalizeModelHandleForRegistry,
} from "@/agent/model";

import {
  buildByokProviderAliases,
  isByokHandleForSelector,
  listProviders,
} from "@/providers/byok-providers";
import { settingsManager } from "@/settings-manager";
import { colors } from "./colors";
import { OverlayShell } from "./OverlayShell";
import { TabBar } from "./TabBar";
import { Text } from "./Text";

const VISIBLE_ITEMS = 8;

type ModelCategory =
  | "recents"
  | "supported"
  | "byok"
  | "byok-all"
  | "all"
  | "server-recommended"
  | "server-all";

const CHATGPT_OAUTH_BASE_PROVIDER = "openai-codex";
const CHATGPT_LABEL_SUFFIX_PATTERN = /\s+\(ChatGPT\)$/;

// Re-export for consumers that import from ModelSelector
export { buildByokProviderAliases, isByokHandleForSelector };

export function usesBackendModelCatalog(
  isSelfHosted?: boolean,
  localModelCatalog?: boolean,
): boolean {
  return Boolean(isSelfHosted || localModelCatalog);
}

export function getEmptyStateActionDescriptors(
  showLoginAction: boolean,
): Array<{
  id: "connect" | "login";
  label: string;
  description: string;
}> {
  return [
    {
      id: "connect",
      label: "/connect",
      description: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
    },
    ...(showLoginAction
      ? [
          {
            id: "login" as const,
            label: "/login",
            description: "Sign in to Letta Constellation",
          },
        ]
      : []),
  ];
}

// Get tab order for model categories.
// For self-hosted servers, only show server-specific tabs.
// For Letta-hosted, keep ordering consistent across billing tiers.
// "recents" is prepended when the user has >= 2 recently used models.
export function getModelCategories(
  _billingTier?: string,
  isSelfHosted?: boolean,
  localModelCatalog?: boolean,
  recentModelCount?: number,
): ModelCategory[] {
  const showRecents =
    (recentModelCount ?? settingsManager.getRecentModels().length) >= 2;
  if (usesBackendModelCatalog(isSelfHosted, localModelCatalog)) {
    const base: ModelCategory[] = ["server-recommended", "server-all"];
    if (showRecents) {
      return ["recents", ...base];
    }
    return base;
  }
  const base: ModelCategory[] = ["supported", "all", "byok", "byok-all"];
  if (showRecents) {
    return ["recents", ...base];
  }
  return base;
}

export type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  registryHandle?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  updateArgs?: Record<string, unknown>;
};

export type ModelSelectorSelection = Pick<
  UiModel,
  "id" | "handle" | "label" | "description" | "registryHandle" | "updateArgs"
>;

export function labelForChatGPTByokAlias(
  label: string,
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return label;

  const providerAlias = handle.slice(0, slashIndex);
  if (byokProviderAliases[providerAlias] !== CHATGPT_OAUTH_BASE_PROVIDER) {
    return label;
  }

  return label.replace(CHATGPT_LABEL_SUFFIX_PATTERN, ` (${providerAlias})`);
}

export function baseHandleForByokAlias(
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const slashIndex = handle.indexOf("/");
  if (slashIndex === -1) return handle;

  const provider = handle.slice(0, slashIndex);
  const model = handle.slice(slashIndex + 1);
  const baseProvider = byokProviderAliases[provider];

  if (baseProvider) {
    return `${baseProvider}/${model}`;
  }
  return handle;
}

export function registryHandleForByokAlias(
  handle: string,
  byokProviderAliases: Record<string, string>,
): string {
  const baseHandle = baseHandleForByokAlias(handle, byokProviderAliases);
  return normalizeModelHandleForRegistry(baseHandle) ?? baseHandle;
}

export function toByokSelectorModel(
  staticModel: UiModel,
  handle: string,
  byokProviderAliases: Record<string, string>,
  updateArgs?: Record<string, unknown>,
): UiModel {
  const resolvedUpdateArgs =
    updateArgs ??
    (staticModel.updateArgs as Record<string, unknown> | undefined);

  return {
    ...staticModel,
    id: handle,
    handle,
    registryHandle: registryHandleForByokAlias(handle, byokProviderAliases),
    label: labelForChatGPTByokAlias(
      staticModel.label,
      handle,
      byokProviderAliases,
    ),
    updateArgs: resolvedUpdateArgs,
  };
}

export function toSelectorModelForHandle(handle: string): UiModel {
  const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
  const modelInfo = getModelInfo(registryHandle);
  if (modelInfo) {
    return {
      id: handle,
      handle,
      registryHandle,
      label: modelInfo.label,
      description: modelInfo.description ?? "",
      updateArgs: modelInfo.updateArgs as Record<string, unknown> | undefined,
    };
  }
  return {
    id: handle,
    handle,
    label: getLocalModelLabel(handle),
    description: "",
  };
}

const API_GATED_MODEL_HANDLES = new Set([
  "letta/auto",
  "letta/auto-fast",
  "letta/glm",
]);

export function includeUnknownBackendHandleInRecommended(
  handle: string,
): boolean {
  const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
  return isLocalModelHandle(registryHandle);
}

export function filterModelsByAvailabilityForSelector<
  T extends { handle: string },
>(
  typedModels: T[],
  availableHandles: Set<string> | null,
  allApiHandles: string[],
): T[] {
  if (availableHandles === null) {
    return typedModels.filter((m) => {
      if (!API_GATED_MODEL_HANDLES.has(m.handle)) {
        return true;
      }
      return allApiHandles.includes(m.handle);
    });
  }

  return typedModels.filter((m) => availableHandles.has(m.handle));
}

interface ModelSelectorProps {
  currentModelId?: string;
  /** The current model's handle (e.g., "anthropic/claude-sonnet-4.6") for accurate current model highlighting */
  currentModelHandle?: string | null;
  currentModelServiceTier?: string | null;
  onSelect: (selection: ModelSelectorSelection) => void;
  onOpenConnect?: () => void;
  onOpenLogin?: () => void;
  onCancel: () => void;
  /** Filter models to only show those matching this provider prefix (e.g., "chatgpt-plus-pro") */
  filterProvider?: string;
  /** Force refresh the models list on mount */
  forceRefresh?: boolean;
  /** User's billing tier (kept for compatibility and future gating logic) */
  billingTier?: string;
  /** Whether connected to a self-hosted server (not api.letta.com) */
  isSelfHosted?: boolean;
  /** Whether the active backend provides a local-only model catalog */
  localModelCatalog?: boolean;
}

export function ModelSelector({
  currentModelId,
  currentModelHandle,
  currentModelServiceTier,
  onSelect,
  onOpenConnect,
  onOpenLogin,
  onCancel,
  filterProvider,
  forceRefresh: forceRefreshOnMount,
  billingTier,
  isSelfHosted,
  localModelCatalog,
}: ModelSelectorProps) {
  const typedModels = models as UiModel[];

  // For self-hosted and local backends, only show the active backend's model catalog.
  const modelCategories = useMemo(
    () => getModelCategories(billingTier, isSelfHosted, localModelCatalog),
    [billingTier, isSelfHosted, localModelCatalog],
  );
  const backendModelCatalog = usesBackendModelCatalog(
    isSelfHosted,
    localModelCatalog,
  );
  const isFreeTier = billingTier === "free";
  const defaultCategory = modelCategories[0] ?? "supported";

  const [category, setCategory] = useState<ModelCategory>(defaultCategory);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const cachedHandlesAtMount = useMemo(() => getCachedModelHandles(), []);

  // undefined: not loaded yet (show spinner)
  // Set<string>: loaded and filtered
  // null: error fallback (show all models + warning)
  const [availableHandles, setAvailableHandles] = useState<
    Set<string> | null | undefined
  >(cachedHandlesAtMount ?? undefined);
  const [allApiHandles, setAllApiHandles] = useState<string[]>(
    cachedHandlesAtMount ? Array.from(cachedHandlesAtMount) : [],
  );
  const [providerTypesByHandle, setProviderTypesByHandle] = useState<
    Map<string, string>
  >(() => getCachedModelProviderTypes() ?? new Map());
  const [isLoading, setIsLoading] = useState(cachedHandlesAtMount === null);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(cachedHandlesAtMount !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [showLoginAction, setShowLoginAction] = useState(false);
  const [byokProviderAliases, setByokProviderAliases] = useState<
    Record<string, string>
  >(() => buildByokProviderAliases([]));

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (isSelfHosted) {
      setShowLoginAction(false);
      return;
    }

    let cancelled = false;
    void settingsManager
      .getSettingsWithSecureTokens()
      .then((settings) => {
        if (cancelled) return;
        setShowLoginAction(!settings.refreshToken);
      })
      .catch(() => {
        if (cancelled) return;
        setShowLoginAction(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isSelfHosted]);

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
      setProviderTypesByHandle(new Map(result.providerTypes));
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
      setProviderTypesByHandle(new Map());
    }
  });

  useEffect(() => {
    loadModels.current(forceRefreshOnMount ?? false);
  }, [forceRefreshOnMount]);

  useEffect(() => {
    if (localModelCatalog) {
      setByokProviderAliases(buildByokProviderAliases([]));
      return;
    }
    (async () => {
      try {
        const providers = await listProviders();
        if (!mountedRef.current) return;
        setByokProviderAliases(buildByokProviderAliases(providers));
      } catch {
        if (!mountedRef.current) return;
        setByokProviderAliases(buildByokProviderAliases([]));
      }
    })();
  }, [localModelCatalog]);

  const pickPreferredStaticModel = useCallback(
    (handle: string, contextWindow?: number): UiModel | undefined => {
      const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
      const staticCandidates = typedModels.filter(
        (m) =>
          m.handle === registryHandle &&
          (contextWindow === undefined ||
            (m.updateArgs?.context_window as number | undefined) ===
              contextWindow),
      );
      return (
        staticCandidates.find((m) => m.isDefault) ??
        staticCandidates.find((m) => m.isFeatured) ??
        staticCandidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "medium",
        ) ??
        staticCandidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "high",
        ) ??
        staticCandidates[0]
      );
    },
    [typedModels],
  );

  const serviceTierForModel = useCallback((model: UiModel): string | null => {
    const value = model.updateArgs?.service_tier;
    return value === CHATGPT_FAST_SERVICE_TIER
      ? CHATGPT_FAST_SERVICE_TIER
      : null;
  }, []);

  const withActualHandle = useCallback(
    (
      model: UiModel,
      handle: string,
      registryHandle?: string,
      updateArgs?: Record<string, unknown>,
    ): UiModel => ({
      ...model,
      id:
        updateArgs?.service_tier === CHATGPT_FAST_SERVICE_TIER
          ? `${handle}::service_tier=${CHATGPT_FAST_SERVICE_TIER}`
          : handle,
      handle,
      registryHandle: registryHandle ?? model.registryHandle ?? model.handle,
      updateArgs: updateArgs ?? model.updateArgs,
    }),
    [],
  );

  const withProviderTypeMetadata = useCallback(
    (
      handle: string,
      updateArgs: Record<string, unknown> | undefined,
    ): Record<string, unknown> | undefined => {
      const providerType = providerTypesByHandle.get(handle);
      if (!providerType) return updateArgs;
      return {
        ...(updateArgs ?? {}),
        provider_type: providerType,
      };
    },
    [providerTypesByHandle],
  );

  const modelsForBackendHandle = useCallback(
    (handle: string, includeUnknown: boolean): UiModel[] => {
      const registryHandle = normalizeModelHandleForRegistry(handle) ?? handle;
      const baseStaticModel = pickPreferredStaticModel(registryHandle);
      const fastRegistryHandle =
        getChatGptFastRegistryHandleForModelHandle(handle);

      const baseUpdateArgs = {
        ...((baseStaticModel?.updateArgs as
          | Record<string, unknown>
          | undefined) ?? {}),
        ...(fastRegistryHandle ? { service_tier: null } : {}),
      };
      const baseUpdateArgsWithProviderType = withProviderTypeMetadata(
        handle,
        Object.keys(baseUpdateArgs).length > 0 ? baseUpdateArgs : undefined,
      );
      const fallbackModel = includeUnknown
        ? toSelectorModelForHandle(handle)
        : null;
      const baseModel = baseStaticModel
        ? withActualHandle(
            baseStaticModel,
            handle,
            registryHandle,
            baseUpdateArgsWithProviderType,
          )
        : fallbackModel
          ? {
              ...fallbackModel,
              updateArgs: withProviderTypeMetadata(
                handle,
                fallbackModel.updateArgs,
              ),
            }
          : null;

      const result = baseModel ? [baseModel] : [];

      if (fastRegistryHandle) {
        const fastStaticModel = pickPreferredStaticModel(fastRegistryHandle);
        if (fastStaticModel) {
          result.push(
            withActualHandle(fastStaticModel, handle, fastRegistryHandle, {
              ...((fastStaticModel.updateArgs as
                | Record<string, unknown>
                | undefined) ?? {}),
              service_tier: CHATGPT_FAST_SERVICE_TIER,
              ...withProviderTypeMetadata(handle, undefined),
            }),
          );
        }
      }

      return result;
    },
    [pickPreferredStaticModel, withActualHandle, withProviderTypeMetadata],
  );

  // Supported models: models.json entries that are available
  // Featured models first, then non-featured, preserving JSON order within each group
  // If filterProvider is set, only show models from that provider
  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    let available = filterModelsByAvailabilityForSelector(
      typedModels,
      availableHandles,
      allApiHandles,
    );
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

    // Deduplicate by handle+context_window: keep one representative entry per unique combo.
    // Models with multiple reasoning tiers (e.g., gpt-5.5 none/low/med/high/max)
    // share the same handle — the ModelReasoningSelector handles tier selection after pick.
    // Models with different context_window (e.g., 200k vs 1M) show separately.
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}:${serviceTierForModel(m) ?? "default"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(pickPreferredStaticModel(m.handle, contextWindow) ?? m);
    }

    const featured = deduped.filter((m) => m.isFeatured);
    const nonFeatured = deduped.filter((m) => !m.isFeatured);
    return [...featured, ...nonFeatured];
  }, [
    typedModels,
    availableHandles,
    allApiHandles,
    filterProvider,
    searchQuery,
    pickPreferredStaticModel,
    serviceTierForModel,
  ]);

  // BYOK models: models from ChatGPT OAuth, standard lc-* providers, or any connected custom BYOK provider
  const isByokHandle = useCallback(
    (handle: string) => isByokHandleForSelector(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  // Letta API (all): all non-BYOK handles from API, including recommended models.
  const allLettaModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const modelsForHandles = allApiHandles
      .filter((handle) => !isByokHandle(handle))
      .map((handle) => {
        const staticModel = pickPreferredStaticModel(handle);
        if (staticModel) {
          return {
            ...staticModel,
            id: handle,
            handle,
          };
        }
        return {
          id: handle,
          handle,
          label: handle,
          description: "",
        } satisfies UiModel;
      });

    if (!searchQuery) {
      return modelsForHandles;
    }

    const query = searchQuery.toLowerCase();
    return modelsForHandles.filter(
      (model) =>
        model.label.toLowerCase().includes(query) ||
        model.description.toLowerCase().includes(query) ||
        model.handle.toLowerCase().includes(query),
    );
  }, [
    availableHandles,
    allApiHandles,
    isByokHandle,
    pickPreferredStaticModel,
    searchQuery,
  ]);

  // Convert BYOK handle to base provider handle for models.json lookup
  // e.g., "lc-anthropic/claude-3-5-haiku" -> "anthropic/claude-3-5-haiku"
  // e.g., "lc-gemini/gemini-2.0-flash" -> "google_ai/gemini-2.0-flash"
  const toBaseHandle = useCallback(
    (handle: string): string =>
      baseHandleForByokAlias(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  // BYOK (recommended): BYOK API handles that have matching entries in models.json
  const byokModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    // Get all BYOK handles from API
    const byokHandles = allApiHandles.filter(isByokHandle);

    // Find models.json entries that match (using alias for lc-* providers)
    const matched: UiModel[] = [];
    for (const handle of byokHandles) {
      const baseHandle = toBaseHandle(handle);
      const staticModel = pickPreferredStaticModel(baseHandle);
      if (staticModel) {
        // Use models.json data but with the BYOK handle as the ID
        matched.push(
          toByokSelectorModel(
            staticModel,
            handle,
            byokProviderAliases,
            withProviderTypeMetadata(
              handle,
              staticModel.updateArgs as Record<string, unknown> | undefined,
            ),
          ),
        );
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
    byokProviderAliases,
    pickPreferredStaticModel,
    searchQuery,
    isByokHandle,
    toBaseHandle,
    withProviderTypeMetadata,
  ]);

  // BYOK (all): all BYOK handles from API (including recommended ones)
  const byokAllModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const byokHandles = allApiHandles.filter(isByokHandle);

    // Apply search filter
    let filtered = byokHandles;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = byokHandles.filter((handle) =>
        handle.toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [availableHandles, allApiHandles, searchQuery, isByokHandle]);

  // Server-recommended models: models.json entries available on the server.
  // Discoverable local endpoint providers (Ollama, LM Studio, llama.cpp) do
  // not have a static models.json catalog, so include their live-discovered
  // handles here instead of hiding them until the user switches to "All".
  // Filter out letta/letta-free legacy model
  const serverRecommendedModels = useMemo(() => {
    if (!backendModelCatalog || availableHandles === undefined) return [];
    let available = allApiHandles
      .filter((handle) => handle !== "letta/letta-free")
      .flatMap((handle) =>
        modelsForBackendHandle(
          handle,
          includeUnknownBackendHandleInRecommended(handle),
        ),
      );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.registryHandle?.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }
    // Deduplicate by handle+context_window (same as supportedModels)
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}:${serviceTierForModel(m) ?? "default"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(m);
    }
    return deduped;
  }, [
    backendModelCatalog,
    availableHandles,
    allApiHandles,
    searchQuery,
    modelsForBackendHandle,
    serviceTierForModel,
  ]);

  // Server-all models: ALL handles from the server (for self-hosted)
  // Filter out letta/letta-free legacy model
  const serverAllModels = useMemo(() => {
    if (!backendModelCatalog) return [];
    const handles = allApiHandles.filter((h) => h !== "letta/letta-free");
    return handles;
  }, [backendModelCatalog, allApiHandles]);

  const serverAllModelRows = useMemo(() => {
    if (!backendModelCatalog) return [];
    let rows = serverAllModels.flatMap((handle) =>
      modelsForBackendHandle(handle, true),
    );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      rows = rows.filter(
        (model) =>
          model.label.toLowerCase().includes(query) ||
          model.description.toLowerCase().includes(query) ||
          model.registryHandle?.toLowerCase().includes(query) ||
          model.handle.toLowerCase().includes(query),
      );
    }
    return rows;
  }, [
    backendModelCatalog,
    serverAllModels,
    modelsForBackendHandle,
    searchQuery,
  ]);

  // Recent models: models the user has recently selected (max 5)
  // Only includes models that are currently available
  const recentModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    const recentHandles = settingsManager.getRecentModels();
    if (recentHandles.length < 2) return []; // Don't show recents with < 2 items

    const resolved: UiModel[] = [];
    for (const handle of recentHandles) {
      // When availableHandles is non-null, skip unavailable models
      if (availableHandles !== null && !availableHandles.has(handle)) continue;

      // Try to resolve to a static model with label/description
      const staticModel = pickPreferredStaticModel(toBaseHandle(handle));
      if (staticModel) {
        resolved.push(
          toByokSelectorModel(
            staticModel,
            handle,
            byokProviderAliases,
            withProviderTypeMetadata(
              handle,
              staticModel.updateArgs as Record<string, unknown> | undefined,
            ),
          ),
        );
      } else {
        const fallbackModel = toSelectorModelForHandle(handle);
        resolved.push({
          ...fallbackModel,
          updateArgs: withProviderTypeMetadata(
            handle,
            fallbackModel.updateArgs,
          ),
        });
      }
    }
    return resolved;
  }, [
    availableHandles,
    byokProviderAliases,
    pickPreferredStaticModel,
    toBaseHandle,
    withProviderTypeMetadata,
  ]);

  // Map category -> list for O(1) lookup
  const categoryListMap = useMemo(
    () => ({
      recents: recentModels,
      supported: supportedModels,
      byok: byokModels,
      "byok-all": byokAllModels.map((handle) => {
        const staticModel = pickPreferredStaticModel(toBaseHandle(handle));
        const staticUpdateArgs = staticModel?.updateArgs as
          | Record<string, unknown>
          | undefined;

        return {
          id: handle,
          handle,
          label: handle,
          description: staticModel?.description ?? "",
          registryHandle: staticModel
            ? registryHandleForByokAlias(handle, byokProviderAliases)
            : undefined,
          updateArgs: withProviderTypeMetadata(handle, staticUpdateArgs),
        };
      }),
      "server-recommended": serverRecommendedModels,
      "server-all": serverAllModelRows,
      all: allLettaModels,
    }),
    [
      recentModels,
      supportedModels,
      byokModels,
      byokAllModels,
      allLettaModels,
      serverRecommendedModels,
      serverAllModelRows,
      byokProviderAliases,
      pickPreferredStaticModel,
      toBaseHandle,
      withProviderTypeMetadata,
    ],
  );

  // Filter out empty categories so the tab bar never shows tabs with 0 items
  const nonEmptyCategories = useMemo(
    () =>
      modelCategories.filter((cat) => {
        const list = categoryListMap[cat];
        if (!list || list.length === 0) return false;
        // Recents tab only shows when there are ≥2 available recent models
        if (cat === "recents" && list.length < 2) return false;
        return true;
      }),
    [modelCategories, categoryListMap],
  );

  // All categories empty → show null state under a single "All" tab
  const allEmpty =
    !isLoading && nonEmptyCategories.length === 0 && !searchQuery;
  const emptyStateActions = useMemo(
    () =>
      getEmptyStateActionDescriptors(showLoginAction).map((action) => ({
        ...action,
        onSelect: action.id === "connect" ? onOpenConnect : onOpenLogin,
      })),
    [onOpenConnect, onOpenLogin, showLoginAction],
  );

  // When all categories are empty, collapse to a single "All" tab
  const displayCategories = useMemo(
    () =>
      allEmpty
        ? ([backendModelCatalog ? "server-all" : "all"] as ModelCategory[])
        : nonEmptyCategories,
    [allEmpty, backendModelCatalog, nonEmptyCategories],
  );

  // Get the list for current category
  const currentList: UiModel[] = useMemo(() => {
    const list = categoryListMap[category] as UiModel[] | undefined;
    return list ?? [];
  }, [category, categoryListMap]);

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

  // Auto-switch to first non-empty category if current category becomes empty
  useEffect(() => {
    if (allEmpty) return;
    if (
      nonEmptyCategories.length > 0 &&
      !nonEmptyCategories.includes(category)
    ) {
      setCategory(nonEmptyCategories[0] as ModelCategory);
      setSelectedIndex(0);
    }
  }, [nonEmptyCategories, category, allEmpty]);

  // Reset selection when category changes
  const cycleCategory = useCallback(() => {
    setCategory((current) => {
      const cats =
        displayCategories.length > 0 ? displayCategories : modelCategories;
      const idx = cats.indexOf(current);
      return cats[(idx + 1) % cats.length] as ModelCategory;
    });
    setSelectedIndex(0);
    setSearchQuery("");
  }, [displayCategories, modelCategories]);

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
    const selectableCount = allEmpty
      ? emptyStateActions.length
      : currentList.length;
    if (selectedIndex >= selectableCount && selectableCount > 0) {
      setSelectedIndex(selectableCount - 1);
    }
  }, [selectedIndex, currentList.length, allEmpty, emptyStateActions.length]);

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

      // Allow 'r' to refresh even while loading. If a refresh is already in
      // flight, consume the key so repeated presses don't turn into search text.
      if (input === "r" && !searchQuery) {
        if (!refreshing) {
          loadModels.current(true);
        }
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
          const cats =
            displayCategories.length > 0 ? displayCategories : modelCategories;
          const idx = cats.indexOf(current);
          return cats[idx === 0 ? cats.length - 1 : idx - 1] as ModelCategory;
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

      if (allEmpty) {
        if (key.upArrow) {
          setSelectedIndex((prev) => Math.max(0, prev - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedIndex((prev) =>
            Math.min(emptyStateActions.length - 1, prev + 1),
          );
          return;
        }
        if (key.return) {
          emptyStateActions[selectedIndex]?.onSelect?.();
          return;
        }
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
      if (isLoading || currentList.length === 0) {
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (key.downArrow) {
        setSelectedIndex((prev) => Math.min(currentList.length - 1, prev + 1));
      } else if (key.return) {
        const selectedModel = currentList[selectedIndex];
        if (selectedModel) {
          onSelect({
            id: selectedModel.id,
            handle: selectedModel.handle,
            label: selectedModel.label,
            description: selectedModel.description,
            registryHandle: selectedModel.registryHandle,
            updateArgs: selectedModel.updateArgs,
          });
        }
      }
    },
    // Keep active so ESC and 'r' work while loading.
    { isActive: true },
  );

  const getCategoryLabel = (cat: ModelCategory) => {
    if (cat === "recents") return `Recents [${recentModels.length}]`;
    if (cat === "supported") return `Letta API [${supportedModels.length}]`;
    if (cat === "byok") return `BYOK [${byokModels.length}]`;
    if (cat === "byok-all") return `BYOK (all) [${byokAllModels.length}]`;
    if (cat === "server-recommended")
      return `Recommended [${serverRecommendedModels.length}]`;
    if (cat === "server-all")
      return `All models [${serverAllModelRows.length}]`;
    return `Letta API (all) [${allLettaModels.length}]`;
  };

  const getCategoryDescription = (cat: ModelCategory) => {
    if (cat === "recents") {
      return "Models you've recently used";
    }
    if (cat === "server-recommended") {
      return "Recommended models currently available for this account";
    }
    if (cat === "server-all") {
      return "All models currently available for this account";
    }
    if (cat === "supported") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "Recommended Letta API models currently available for this account";
    }
    if (cat === "byok")
      return "Recommended models via your connected API keys (use /connect to add more)";
    if (cat === "byok-all")
      return "All models via your connected API keys (use /connect to add more)";
    if (cat === "all") {
      return isFreeTier
        ? "Upgrade your account to access more models"
        : "All Letta API models currently available for this account";
    }
    return "All Letta API models currently available for this account";
  };

  return (
    <OverlayShell
      command="/model"
      title="Swap your agent's model"
      footer={
        !isLoading && currentList.length > 0 ? (
          <Box flexDirection="column">
            <Text dimColor>
              {"  "}
              {currentList.length} models{isCached ? " · cached" : ""}
              {refreshing ? " · refreshing..." : " · R to refresh list"}
            </Text>
            <Text dimColor>
              {"  "}Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel
            </Text>
          </Box>
        ) : undefined
      }
    >
      {!isLoading && !allEmpty && (
        <Box flexDirection="column" paddingLeft={1} marginBottom={1}>
          <TabBar
            tabs={displayCategories}
            activeTab={category}
            getLabel={getCategoryLabel}
          />
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

      {/* Null state — no models available */}
      {!isLoading && allEmpty && (
        <Box flexDirection="column" paddingLeft={1}>
          <TabBar
            tabs={displayCategories}
            activeTab={displayCategories[0] as ModelCategory}
            getLabel={getCategoryLabel}
          />
          <Box flexDirection="column" paddingLeft={1} marginTop={1}>
            <Text dimColor>No models available.</Text>
            <Text dimColor>
              Set an LLM API key in your env and restart `letta` or use the
              following options:
            </Text>
            <Box height={1} />
            {emptyStateActions.map((action, index) => {
              const isSelected = index === selectedIndex;
              return (
                <Box key={action.id} flexDirection="column" marginBottom={1}>
                  <Text
                    color={
                      isSelected ? colors.selector.itemHighlighted : undefined
                    }
                  >
                    {isSelected ? "> " : "  "}
                    {action.label}
                  </Text>
                  <Box paddingLeft={2}>
                    <Text dimColor>{action.description}</Text>
                  </Box>
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {/* Loading states */}
      {isLoading && (
        <Box paddingLeft={2}>
          <Text dimColor>Loading available models...</Text>
        </Box>
      )}

      {error && (
        <Box paddingLeft={2}>
          <Text color="yellow">
            Warning: Could not fetch available models. Showing all models.
          </Text>
        </Box>
      )}

      {!isLoading && !allEmpty && visibleModels.length === 0 && (
        <Box paddingLeft={2}>
          <Text dimColor>
            {searchQuery
              ? "No models match your search."
              : "No additional models available."}
          </Text>
        </Box>
      )}

      {/* Model list */}
      {refreshing && (
        <Box paddingLeft={2}>
          <Text dimColor>Refreshing list...</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {visibleModels.map((model, index) => {
          const actualIndex = startIndex + index;
          const isSelected = actualIndex === selectedIndex;
          const modelServiceTier = serviceTierForModel(model);
          const currentServiceTier =
            currentModelServiceTier === CHATGPT_FAST_SERVICE_TIER
              ? CHATGPT_FAST_SERVICE_TIER
              : null;
          const isCurrent =
            (model.id === currentModelId ||
              model.handle === currentModelHandle) &&
            modelServiceTier === currentServiceTier;
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
    </OverlayShell>
  );
}
