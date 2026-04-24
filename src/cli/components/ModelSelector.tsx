// Import useInput from vendored Ink for bracketed paste support
import { Box, useInput } from "ink";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
  getAvailableModelsCacheInfo,
  getCachedModelHandles,
} from "../../agent/available-models";
import { models } from "../../agent/model";
import {
  buildByokProviderAliases,
  isByokHandleForSelector,
  listProviders,
} from "../../providers/byok-providers";
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

// Re-export for consumers that import from ModelSelector
export { buildByokProviderAliases, isByokHandleForSelector };

// Get tab order for model categories.
// For self-hosted servers, only show server-specific tabs.
// For Letta-hosted, keep ordering consistent across billing tiers.
export function getModelCategories(
  _billingTier?: string,
  isSelfHosted?: boolean,
): ModelCategory[] {
  if (isSelfHosted) {
    return ["server-recommended", "server-all"];
  }
  return ["supported", "all", "byok", "byok-all"];
}

type UiModel = {
  id: string;
  handle: string;
  label: string;
  description: string;
  isDefault?: boolean;
  isFeatured?: boolean;
  free?: boolean;
  legacy?: boolean;
  updateArgs?: Record<string, unknown>;
};

const API_GATED_MODEL_HANDLES = new Set(["letta/auto", "letta/auto-fast"]);

/**
 * Parse a model label into a family name, semantic version, and modifier.
 *
 * `family` is the text BEFORE the first version token, `modifier` is the
 * text AFTER it. Keeping modifier separate from family lets us group
 * sibling variants (Opus 4.6 and Opus 4.6 1M, GPT-5.5 and GPT-5.5 Fast)
 * together while still sorting them deterministically within a version.
 *
 * Examples:
 *   "GLM-5.1"           → { family: "glm",          version: [5, 1], modifier: "" }
 *   "GPT-5.5 (ChatGPT)" → { family: "gpt",          version: [5, 5], modifier: "(chatgpt)" }
 *   "GPT-5.5 Fast"      → { family: "gpt",          version: [5, 5], modifier: "fast" }
 *   "GPT-5.1 Codex"     → { family: "gpt",          version: [5, 1], modifier: "codex" }
 *   "GPT-5.1 Codex Max" → { family: "gpt",          version: [5, 1], modifier: "codex max" }
 *   "Opus 4.6"          → { family: "opus",         version: [4, 6], modifier: "" }
 *   "Opus 4.6 1M"       → { family: "opus",         version: [4, 6], modifier: "1m" }
 *   "Kimi K2.6"         → { family: "kimi k",       version: [2, 6], modifier: "" }
 *   "MiniMax 2.7"       → { family: "minimax",      version: [2, 7], modifier: "" }
 *   "Bedrock Opus 4.6"  → { family: "bedrock opus", version: [4, 6], modifier: "" }
 *
 * Family and modifier are lowercased so case differences across models
 * (e.g. "MiniMax" vs "Minimax") still group together.
 */
export function parseModelLabel(label: string): {
  family: string;
  version: number[];
  modifier: string;
} {
  const normalize = (s: string) =>
    s
      .replace(/[\s-]+/g, " ")
      .trim()
      .toLowerCase();
  const versionMatch = label.match(/(\d+(?:\.\d+)*)/);
  const versionToken = versionMatch?.[1];
  if (!versionMatch || !versionToken) {
    return { family: normalize(label), version: [0], modifier: "" };
  }
  const versionStart = versionMatch.index ?? 0;
  const versionEnd = versionStart + versionToken.length;
  const version = versionToken.split(".").map((n) => parseInt(n, 10));
  const family = normalize(label.slice(0, versionStart));
  const modifier = normalize(label.slice(versionEnd));
  return { family, version, modifier };
}

/**
 * A set of families that share a release cadence and should sort together
 * "by generation". Within a group, version is the primary sort key; within
 * a version, the family index in `families` is the secondary (so passing
 * `["haiku", "sonnet", "opus"]` produces smaller-tier-first inside each
 * Claude generation).
 */
export type GenerationGroup = {
  name: string;
  families: string[];
};

/**
 * Anthropic's Claude line ships Haiku / Sonnet / Opus together each
 * generation, so we treat them as one sort group: version first, smaller
 * tier first inside the version. Produces e.g.
 *   Opus 4.7 → Sonnet 4.6 → Sonnet 4.6 1M → Opus 4.6 → Opus 4.6 1M → Opus 4.5
 */
const DEFAULT_GENERATION_GROUPS: GenerationGroup[] = [
  { name: "anthropic", families: ["haiku", "sonnet", "opus"] },
];

type SortOptions = {
  priorityFamilies?: string[];
  generationGroups?: GenerationGroup[];
};

/**
 * Sort a list of raw API handles using the same newer-first-within-family
 * policy as sortModelsByFamilyAndVersion. Each handle is resolved to a label
 * via `labelFor`; handles without a label fall back to the handle string
 * itself, which still gives reasonable family grouping via the provider
 * prefix.
 */
export function sortHandlesByFamilyAndVersion(
  handles: string[],
  labelFor: (handle: string) => string | undefined,
  options?: SortOptions,
): string[] {
  const wrapped = handles.map((handle) => ({
    handle,
    label: labelFor(handle) ?? handle,
  }));
  return sortModelsByFamilyAndVersion(wrapped, options).map((w) => w.handle);
}

/**
 * Sort models so that within each family the newest version appears first,
 * while preserving the order in which families first appear in the input
 * (so provider grouping is still driven by the upstream list). Callers can
 * pass `priorityFamilies` to pin specific families to the top in a given
 * order — by default no family is pinned.
 *
 * Families that belong to a generation group (see `generationGroups`, which
 * defaults to the Anthropic tier trio) are collapsed into a single group
 * for sorting purposes: generation (version) first, then tier index.
 *
 * Tie-break order: groupFamily order → version desc → tier index within
 * generation group asc → modifier asc (so base sorts before "Fast"/"1M"/
 * "Codex" variants) → featured first → stable original position.
 */
export function sortModelsByFamilyAndVersion<
  T extends { label: string; isFeatured?: boolean },
>(models: T[], options?: SortOptions): T[] {
  const generationGroups =
    options?.generationGroups ?? DEFAULT_GENERATION_GROUPS;
  const findGroup = (family: string) => {
    for (const g of generationGroups) {
      const idx = g.families.indexOf(family);
      if (idx >= 0) return { name: g.name, idx };
    }
    return null;
  };

  const annotated = models.map((m, originalIndex) => {
    const parsed = parseModelLabel(m.label);
    const group = findGroup(parsed.family);
    return {
      model: m,
      originalIndex,
      family: parsed.family,
      version: parsed.version,
      modifier: parsed.modifier,
      // `sortFamily` is what drives the cross-family ordering: members of
      // the same generation group share one key so they stay adjacent.
      sortFamily: group?.name ?? parsed.family,
      // `groupTierIdx` is only meaningful inside a generation group — it
      // orders tiers (Haiku < Sonnet < Opus) at the same version.
      groupTierIdx: group?.idx ?? 0,
    };
  });

  const familyOrder = new Map<string, number>();
  // Seed with any caller-supplied priority list first so those families win
  // the appearance race regardless of where they show up in the input.
  for (const fam of options?.priorityFamilies ?? []) {
    if (!familyOrder.has(fam)) {
      familyOrder.set(fam, familyOrder.size);
    }
  }
  for (const entry of annotated) {
    if (!familyOrder.has(entry.sortFamily)) {
      familyOrder.set(entry.sortFamily, familyOrder.size);
    }
  }
  annotated.sort((a, b) => {
    const famDiff =
      (familyOrder.get(a.sortFamily) ?? 0) -
      (familyOrder.get(b.sortFamily) ?? 0);
    if (famDiff !== 0) return famDiff;
    const len = Math.max(a.version.length, b.version.length);
    for (let i = 0; i < len; i++) {
      const av = a.version[i] ?? 0;
      const bv = b.version[i] ?? 0;
      if (av !== bv) return bv - av;
    }
    // Inside a generation group, smaller tier first (Haiku → Sonnet → Opus).
    if (a.groupTierIdx !== b.groupTierIdx) {
      return a.groupTierIdx - b.groupTierIdx;
    }
    // Base model (empty modifier) sorts before its variants; among variants,
    // alphabetical so "fast" < "fast (chatgpt)" and "codex" < "codex max".
    if (a.modifier !== b.modifier) {
      return a.modifier.localeCompare(b.modifier);
    }
    const aRank = a.model.isFeatured ? 0 : 1;
    const bRank = b.model.isFeatured ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.originalIndex - b.originalIndex;
  });
  return annotated.map((entry) => entry.model);
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
  onSelect: (modelId: string) => void;
  onCancel: () => void;
  /** Filter models to only show those matching this provider prefix (e.g., "chatgpt-plus-pro") */
  filterProvider?: string;
  /** Force refresh the models list on mount */
  forceRefresh?: boolean;
  /** User's billing tier (kept for compatibility and future gating logic) */
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

  // For self-hosted, only show server-specific tabs
  const modelCategories = useMemo(
    () => getModelCategories(billingTier, isSelfHosted),
    [billingTier, isSelfHosted],
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
  const [isLoading, setIsLoading] = useState(cachedHandlesAtMount === null);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState(cachedHandlesAtMount !== null);
  const [refreshing, setRefreshing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
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

  useEffect(() => {
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
  }, []);

  const pickPreferredStaticModel = useCallback(
    (handle: string, contextWindow?: number): UiModel | undefined => {
      const staticCandidates = typedModels.filter(
        (m) =>
          m.handle === handle &&
          (contextWindow === undefined ||
            (m.updateArgs?.context_window as number | undefined) ===
              contextWindow),
      );
      if (staticCandidates.length === 0) return undefined;
      // Prefer a non-legacy representative when one exists so handles with a
      // mix of legacy/current variants (e.g. the Opus 4.6 high-reasoning
      // entry that still says "(legacy)") surface under their non-legacy
      // description. Fall back to legacy only when that's all we have —
      // this keeps the "(all)" tabs able to show a description for
      // legacy-only handles.
      const nonLegacy = staticCandidates.filter((m) => !m.legacy);
      const candidates = nonLegacy.length > 0 ? nonLegacy : staticCandidates;
      return (
        candidates.find((m) => m.isDefault) ??
        candidates.find((m) => m.isFeatured) ??
        candidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "medium",
        ) ??
        candidates.find(
          (m) =>
            (m.updateArgs as { reasoning_effort?: unknown } | undefined)
              ?.reasoning_effort === "high",
        ) ??
        candidates[0]
      );
    },
    [typedModels],
  );

  // Supported models: models.json entries that are available.
  // Legacy entries are hidden here; they remain reachable via the "(all)" tab.
  // Final order: grouped by family, newer versions first within family,
  // featured breaks ties. If filterProvider is set, only show that provider.
  const supportedModels = useMemo(() => {
    if (availableHandles === undefined) return [];
    let available = filterModelsByAvailabilityForSelector(
      typedModels,
      availableHandles,
      allApiHandles,
    );
    // Hide legacy from the recommended tab.
    available = available.filter((m) => !m.legacy);
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
    // Models with multiple reasoning tiers (e.g., gpt-5.3-codex none/low/med/high/max)
    // share the same handle — the ModelReasoningSelector handles tier selection after pick.
    // Models with different context_window (e.g., 200k vs 1M) show separately.
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(pickPreferredStaticModel(m.handle, contextWindow) ?? m);
    }

    return sortModelsByFamilyAndVersion(deduped);
  }, [
    typedModels,
    availableHandles,
    allApiHandles,
    filterProvider,
    searchQuery,
    pickPreferredStaticModel,
  ]);

  // BYOK models: models from ChatGPT OAuth, standard lc-* providers, or any connected custom BYOK provider
  const isByokHandle = useCallback(
    (handle: string) => isByokHandleForSelector(handle, byokProviderAliases),
    [byokProviderAliases],
  );

  // Letta API (all): all non-BYOK handles from API, including recommended models.
  // Legacy entries stay visible here (that's the point of "(all)") but we still
  // sort newer-first within each family so the order is consistent with the
  // recommended tab.
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

    const filtered = searchQuery
      ? (() => {
          const query = searchQuery.toLowerCase();
          return modelsForHandles.filter(
            (model) =>
              model.label.toLowerCase().includes(query) ||
              model.description.toLowerCase().includes(query) ||
              model.handle.toLowerCase().includes(query),
          );
        })()
      : modelsForHandles;

    return sortModelsByFamilyAndVersion(filtered);
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
    (handle: string): string => {
      const slashIndex = handle.indexOf("/");
      if (slashIndex === -1) return handle;

      const provider = handle.slice(0, slashIndex);
      const model = handle.slice(slashIndex + 1);
      const baseProvider = byokProviderAliases[provider];

      if (baseProvider) {
        return `${baseProvider}/${model}`;
      }
      return handle;
    },
    [byokProviderAliases],
  );

  // BYOK (recommended): BYOK API handles that have matching entries in models.json.
  // Legacy entries are hidden (still reachable under "BYOK (all)").
  // Output is sorted by family → newer version first, independent of the
  // API handle ordering we happened to receive.
  const byokModels = useMemo(() => {
    if (availableHandles === undefined) return [];

    // Get all BYOK handles from API
    const byokHandles = allApiHandles.filter(isByokHandle);

    // Find models.json entries that match (using alias for lc-* providers).
    // Dedupe by (baseHandle, contextWindow) so users who have the same
    // underlying model connected via multiple BYOK providers (e.g. direct
    // Anthropic key AND a custom-provider forward) only see one row.
    const matched: UiModel[] = [];
    const seenBase = new Set<string>();
    for (const handle of byokHandles) {
      const baseHandle = toBaseHandle(handle);
      const staticModel = pickPreferredStaticModel(baseHandle);
      if (!staticModel) continue;
      const contextWindow = staticModel.updateArgs?.context_window as
        | number
        | undefined;
      const dedupKey = `${baseHandle}:${contextWindow ?? 0}`;
      if (seenBase.has(dedupKey)) continue;
      seenBase.add(dedupKey);
      // Use models.json data but with the BYOK handle as the ID
      matched.push({
        ...staticModel,
        id: handle,
        handle: handle,
      });
    }

    // Drop legacy models from the recommended view.
    let filtered = matched.filter((m) => !m.legacy);

    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }

    return sortModelsByFamilyAndVersion(filtered);
  }, [
    availableHandles,
    allApiHandles,
    pickPreferredStaticModel,
    searchQuery,
    isByokHandle,
    toBaseHandle,
  ]);

  // BYOK (all): all BYOK handles from API (including recommended ones).
  // Sorted newer-first within family via label lookup (using the base handle
  // alias so "lc-anthropic/..." resolves against models.json "anthropic/...").
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

    return sortHandlesByFamilyAndVersion(filtered, (handle) => {
      const baseHandle = toBaseHandle(handle);
      return typedModels.find((m) => m.handle === baseHandle)?.label;
    });
  }, [
    availableHandles,
    allApiHandles,
    searchQuery,
    isByokHandle,
    toBaseHandle,
    typedModels,
  ]);

  // Server-recommended models: models.json entries available on the server (for self-hosted)
  // Filter out letta/letta-free legacy model and the broader `legacy: true` set.
  const serverRecommendedModels = useMemo(() => {
    if (!isSelfHosted || availableHandles === undefined) return [];
    let available = typedModels.filter(
      (m) =>
        availableHandles?.has(m.handle) &&
        m.handle !== "letta/letta-free" &&
        !m.legacy,
    );
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      available = available.filter(
        (m) =>
          m.label.toLowerCase().includes(query) ||
          m.description.toLowerCase().includes(query) ||
          m.handle.toLowerCase().includes(query),
      );
    }
    // Deduplicate by handle+context_window (same as supportedModels)
    const seen = new Set<string>();
    const deduped: UiModel[] = [];
    for (const m of available) {
      const contextWindow = m.updateArgs?.context_window as number | undefined;
      const key = `${m.handle}:${contextWindow ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(pickPreferredStaticModel(m.handle, contextWindow) ?? m);
    }
    return sortModelsByFamilyAndVersion(deduped);
  }, [
    isSelfHosted,
    typedModels,
    availableHandles,
    searchQuery,
    pickPreferredStaticModel,
  ]);

  // Server-all models: ALL handles from the server (for self-hosted)
  // Filter out letta/letta-free legacy model. Sort newer-first within family
  // (handles without a models.json match sort by their handle string).
  const serverAllModels = useMemo(() => {
    if (!isSelfHosted) return [];
    let handles = allApiHandles.filter((h) => h !== "letta/letta-free");
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      handles = handles.filter((h) => h.toLowerCase().includes(query));
    }
    return sortHandlesByFamilyAndVersion(
      handles,
      (handle) => typedModels.find((m) => m.handle === handle)?.label,
    );
  }, [isSelfHosted, allApiHandles, searchQuery, typedModels]);

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
    return allLettaModels;
  }, [
    category,
    supportedModels,
    byokModels,
    byokAllModels,
    allLettaModels,
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
    return `Letta API (all) [${allLettaModels.length}]`;
  };

  const getCategoryDescription = (cat: ModelCategory) => {
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
            color={isActive ? "white" : undefined}
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
        {!isLoading && (
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
      {refreshing && (
        <Box paddingLeft={2}>
          <Text dimColor>Refreshing list...</Text>
        </Box>
      )}
      <Box flexDirection="column">
        {!refreshing &&
          visibleModels.map((model, index) => {
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
                  color={
                    isSelected ? colors.selector.itemHighlighted : undefined
                  }
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
        {!refreshing && showScrollDown ? (
          <Text dimColor>
            {"  "}↓ {itemsBelow} more below
          </Text>
        ) : !refreshing && currentList.length > visibleCount ? (
          <Text> </Text>
        ) : null}
      </Box>

      {/* Footer */}
      {!isLoading && currentList.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            {"  "}
            {currentList.length} models{isCached ? " · cached" : ""} · R to
            refresh list
          </Text>
          <Text dimColor>
            {"  "}Enter select · ↑↓ navigate · ←→/Tab switch · Esc cancel
          </Text>
        </Box>
      )}
    </Box>
  );
}
