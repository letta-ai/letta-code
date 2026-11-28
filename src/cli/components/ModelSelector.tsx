import type { LettaCodeModelEntry } from "@letta-ai/letta-agent-sdk";
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CHATGPT_FAST_SERVICE_TIER,
  getChatGptFastRegistryHandleForModelHandle,
  normalizeModelHandleForRegistry,
} from "@/agent/model";

import {
  buildByokProviderAliases,
  isByokHandleForSelector,
} from "@/providers/byok-providers";
import { colors } from "./colors";
import {
  baseHandleForByokAlias,
  filterModelsByAvailabilityForSelector,
  getEmptyStateActionDescriptors,
  includeUnknownBackendHandleInRecommended,
  labelForBackendModel,
  type ModelSelectorSelection,
  registryHandleForBackendModel,
  registryHandleForByokAlias,
  toByokSelectorModel,
  toSelectorModelForHandle,
  type UiModel,
  usesBackendModelCatalog,
  withProviderMetadataForSelector,
} from "./model-selector-helpers";
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

export { buildByokProviderAliases, isByokHandleForSelector };
export type {
  ModelSelectorSelection,
  UiModel,
} from "./model-selector-helpers";
export {
  filterModelsByAvailabilityForSelector,
  getEmptyStateActionDescriptors,
  includeUnknownBackendHandleInRecommended,
  labelForBackendModel,
  labelForChatGPTByokAlias,
  registryHandleForBackendModel,
  registryHandleForByokAlias,
  toByokSelectorModel,
  toSelectorModelForHandle,
  usesBackendModelCatalog,
  withProviderMetadataForSelector,
} from "./model-selector-helpers";

export function getModelCategories(
  _billingTier?: string,
  isSelfHosted?: boolean,
  localModelCatalog?: boolean,
  recentModelCount?: number,
): ModelCategory[] {
  const showRecents = (recentModelCount ?? 0) >= 2;
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

interface ModelSelectorProps {
  currentModelId?: string;
  currentModelHandle?: string | null;
  currentModelServiceTier?: string | null;
  onSelect: (selection: ModelSelectorSelection) => void;
  onOpenConnect: () => void;
  onCancel: () => void;
  refresh: () => Promise<void>;
  entries: LettaCodeModelEntry[];
  handles?: string[] | null;
  aliases?: Record<string, string>;
  localModelCatalog?: boolean;
}

export function ModelSelector({
  currentModelId,
  currentModelHandle,
  currentModelServiceTier,
  onSelect,
  onOpenConnect,
  onCancel,
  entries,
  handles,
  aliases,
  refresh,
  localModelCatalog,
}: ModelSelectorProps) {
  const typedModels = useMemo(
    () =>
      entries.map((entry) => ({
        ...entry,
        description: entry.description ?? "",
      })),
    [entries],
  );
  const modelCategories = useMemo(
    () => getModelCategories(undefined, false, localModelCatalog, 0),
    [localModelCatalog],
  );
  const backendModelCatalog = !!localModelCatalog;
  const isFreeTier = false;
  const [category, setCategory] = useState<ModelCategory>(
    modelCategories[0] ?? "supported",
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const allApiHandles = useMemo(
    () => handles ?? [...new Set(entries.map((e) => e.handle))],
    [entries, handles],
  );
  const availableHandles = useMemo(
    () => new Set(allApiHandles),
    [allApiHandles],
  );
  const byokProviderAliases = useMemo(() => aliases ?? {}, [aliases]);
  const providerTypesByHandle = useMemo(
    () =>
      new Map(
        typedModels.flatMap((m) =>
          typeof m.updateArgs?.provider_type === "string"
            ? [[m.handle, m.updateArgs.provider_type] as const]
            : [],
        ),
      ),
    [typedModels],
  );
  const openAICompatibleProxyHandles = useMemo(() => new Set<string>(), []);
  const openAICompatibleProxyProviders = useMemo(() => new Set<string>(), []);
  const filterProvider = undefined;
  const isCached = false;
  const isLoading = false;
  const showLoginAction = false;
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
      const providerName = handle.split("/")[0];
      return withProviderMetadataForSelector(
        updateArgs,
        providerType,
        isByokHandleForSelector(handle, byokProviderAliases),
        openAICompatibleProxyHandles.has(handle) ||
          (providerName !== undefined &&
            openAICompatibleProxyProviders.has(providerName)),
      );
    },
    [
      byokProviderAliases,
      openAICompatibleProxyHandles,
      openAICompatibleProxyProviders,
      providerTypesByHandle,
    ],
  );

  const modelsForBackendHandle = useCallback(
    (handle: string, includeUnknown: boolean): UiModel[] => {
      const providerType = providerTypesByHandle.get(handle);
      const registryHandle = registryHandleForBackendModel(
        handle,
        providerType,
      );
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
            {
              ...baseStaticModel,
              label: labelForBackendModel(baseStaticModel.label, providerType),
            },
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
    [
      pickPreferredStaticModel,
      providerTypesByHandle,
      withActualHandle,
      withProviderTypeMetadata,
    ],
  );

  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    let available = filterModelsByAvailabilityForSelector(
      typedModels,
      availableHandles,
      allApiHandles,
    );
    if (filterProvider) {
      available = available.filter((m) =>
        m.handle.startsWith(`${filterProvider}/`),
      );
    }
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

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

  const isByokHandle = useCallback(
    (handle: string) => isByokHandleForSelector(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  const allLettaModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const modelsForHandles = allApiHandles
      .filter((handle) => !isByokHandle(handle))
      .map((handle) => {
        const staticModel = pickPreferredStaticModel(handle);
        return {
          ...(staticModel ?? { label: handle, description: "" }),
          id: handle,
          handle,
          updateArgs: withProviderTypeMetadata(
            handle,
            staticModel?.updateArgs as Record<string, unknown> | undefined,
          ),
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
    withProviderTypeMetadata,
  ]);

  const toBaseHandle = useCallback(
    (handle: string): string =>
      baseHandleForByokAlias(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  const byokModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const byokHandles = allApiHandles.filter(isByokHandle);

    const matched: UiModel[] = [];
    for (const handle of byokHandles) {
      const baseHandle = toBaseHandle(handle);
      const staticModel = pickPreferredStaticModel(baseHandle);
      if (staticModel) {
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

  const byokAllModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    const byokHandles = allApiHandles.filter(isByokHandle);

    let filtered = byokHandles;
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = byokHandles.filter((handle) =>
        handle.toLowerCase().includes(query),
      );
    }

    return filtered;
  }, [availableHandles, allApiHandles, searchQuery, isByokHandle]);

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

  const recentModels = useMemo<UiModel[]>(() => [], []);
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

  const nonEmptyCategories = useMemo(
    () =>
      modelCategories.filter((cat) => {
        const list = categoryListMap[cat];
        if (!list || list.length === 0) return false;
        if (cat === "recents" && list.length < 2) return false;
        return true;
      }),
    [modelCategories, categoryListMap],
  );

  const allEmpty =
    !isLoading && nonEmptyCategories.length === 0 && !searchQuery;
  const emptyStateActions = useMemo(
    () =>
      getEmptyStateActionDescriptors(showLoginAction).map((action) => ({
        ...action,
        onSelect: onOpenConnect,
      })),
    [onOpenConnect],
  );

  const displayCategories = useMemo(
    () =>
      allEmpty
        ? ([backendModelCatalog ? "server-all" : "all"] as ModelCategory[])
        : nonEmptyCategories,
    [allEmpty, backendModelCatalog, nonEmptyCategories],
  );

  const currentList: UiModel[] = useMemo(() => {
    const list = categoryListMap[category] as UiModel[] | undefined;
    return list ?? [];
  }, [category, categoryListMap]);

  const visibleCount = VISIBLE_ITEMS - 1;

  const startIndex = useMemo(() => {
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
      if (key.ctrl && input === "c") {
        onCancel();
        return;
      }

      if (key.escape) {
        if (searchQuery) {
          setSearchQuery("");
          setSelectedIndex(0);
        } else {
          onCancel();
        }
        return;
      }

      if (input === "r" && !searchQuery) {
        if (!refreshing) {
          setRefreshing(true);
          void refresh()
            .then(() => setError(null))
            .catch((e) => setError(String(e)))
            .finally(() => setRefreshing(false));
        }
        return;
      }

      if (key.tab || key.rightArrow) {
        cycleCategory();
        return;
      }

      if (key.leftArrow) {
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
