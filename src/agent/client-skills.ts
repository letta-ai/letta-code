import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import type { AvailableSkillSummary } from "@/types/protocol_v2";
import { ClientSkillsWatcher } from "./client-skills-watcher";
import { getSkillSources, getSkillsDirectory } from "./context";
import { resolveScopedMemoryDir } from "./memory-filesystem";
import type { AttachedAgentRepository } from "./memory-git";
import {
  discoverSharedMemorySkills,
  invalidateAttachedRepositoriesCache,
  resolveSharedMemorySkillsContext,
} from "./shared-memory-skills";
import {
  compareSkills,
  discoverSkills,
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
  isModelInvocableSkill,
  isSkillAvailableForAgent,
  PROJECT_SKILLS_DIR,
  SKILLS_DIR,
  type Skill,
  type SkillDiscoveryError,
  type SkillDiscoveryResult,
  type SkillSource,
} from "./skills";

// ---------------------------------------------------------------------------
// Cache layer
// ---------------------------------------------------------------------------

/**
 * In-memory cache for `buildClientSkillsPayload` results.
 *
 * Stored on `globalThis` via `Symbol.for()` so it survives Bun's bundler
 * deduplication (same pattern as secretsStore).
 */
const CLIENT_SKILLS_CACHE_KEY = Symbol.for("@letta/clientSkillsCache");
const CLIENT_SKILLS_CACHE_GENERATION_KEY = Symbol.for(
  "@letta/clientSkillsCacheGeneration",
);
const CLIENT_SKILLS_WATCHER_KEY = Symbol.for("@letta/clientSkillsWatcher");

interface CacheEntry {
  key: string;
  result: BuildClientSkillsPayloadResult;
}

type ClientSkillsCache = Map<string, CacheEntry>;

type GlobalWithClientSkillsCache = typeof globalThis & {
  [key: symbol]: ClientSkillsCache | undefined;
};

type GlobalWithClientSkillsState = typeof globalThis & {
  [CLIENT_SKILLS_CACHE_GENERATION_KEY]?: number;
  [CLIENT_SKILLS_WATCHER_KEY]?: ClientSkillsWatcher;
};

function getCache(): ClientSkillsCache {
  const global = globalThis as GlobalWithClientSkillsCache;
  if (!global[CLIENT_SKILLS_CACHE_KEY]) {
    global[CLIENT_SKILLS_CACHE_KEY] = new Map();
  }
  return global[CLIENT_SKILLS_CACHE_KEY] as ClientSkillsCache;
}

function getCacheGeneration(): number {
  const global = globalThis as GlobalWithClientSkillsState;
  return global[CLIENT_SKILLS_CACHE_GENERATION_KEY] ?? 0;
}

function advanceCacheGeneration(): void {
  const global = globalThis as GlobalWithClientSkillsState;
  global[CLIENT_SKILLS_CACHE_GENERATION_KEY] = getCacheGeneration() + 1;
}

function shouldStartSkillWatchers(): boolean {
  return (
    process.env.NODE_ENV !== "test" &&
    process.env.LETTA_DISABLE_SKILL_WATCHERS !== "1"
  );
}

function getWatcher(): ClientSkillsWatcher {
  const global = globalThis as GlobalWithClientSkillsState;
  if (!global[CLIENT_SKILLS_WATCHER_KEY]) {
    global[CLIENT_SKILLS_WATCHER_KEY] = new ClientSkillsWatcher(() => {
      invalidateClientSkillsPayloadCache();
    });
  }
  return global[CLIENT_SKILLS_WATCHER_KEY];
}

/**
 * Compute a cache key from the parameters that influence skill discovery.
 *
 * We include:
 *  - agentId
 *  - sorted skill sources
 *  - cwd (affects `.agents/skills` and `.skills` resolution)
 *  - configured skills directory
 *  - legacy and primary project skills directories
 *  - resolved memory skills dirs (scoped or env-fallback)
 *  - attached shared-memory skill dirs and attachment-resolution errors
 *
 * Filesystem changes invalidate this cache through ClientSkillsWatcher rather
 * than adding a recursive filesystem revision to this request-time key.
 */
function computeCacheKey(components: {
  agentId: string | undefined;
  skillSources: SkillSource[];
  cwd: string;
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  memorySkillsDirs: string[];
  sharedMemorySkillsDirs: string[];
  sharedMemoryErrors: SkillDiscoveryError[];
}): string {
  return [
    components.agentId ?? "",
    [...components.skillSources].sort().join(","),
    components.cwd,
    components.configuredSkillsDirectory ?? "",
    components.legacySkillsDirectory,
    components.primaryProjectSkillsDirectory,
    [...components.memorySkillsDirs].sort().join(","),
    [...components.sharedMemorySkillsDirs].sort().join(","),
    components.sharedMemoryErrors
      .map((error) => `${error.path}:${error.message}`)
      .sort()
      .join(","),
  ].join("|");
}

function getSkillRoots(components: {
  agentId: string | undefined;
  skillSources: SkillSource[];
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  memorySkillsDirs: string[];
  sharedMemorySkillsDirs: string[];
}): string[] {
  const roots = new Set<string>();
  const sourceSet = new Set(components.skillSources);

  if (sourceSet.has("project")) {
    if (components.configuredSkillsDirectory) {
      roots.add(components.configuredSkillsDirectory);
    }
    roots.add(components.legacySkillsDirectory);
    roots.add(components.primaryProjectSkillsDirectory);
  }
  if (sourceSet.has("global")) {
    roots.add(GLOBAL_SKILLS_DIR);
  }
  if (components.agentId && sourceSet.has("agent")) {
    roots.add(getAgentSkillsDir(components.agentId));
  }

  if (components.skillSources.length > 0) {
    for (const dir of components.memorySkillsDirs) {
      roots.add(dir);
    }
    for (const dir of components.sharedMemorySkillsDirs) {
      roots.add(dir);
    }
  }

  return [...roots];
}

/**
 * Deep-clone a `BuildClientSkillsPayloadResult` so callers cannot
 * accidentally mutate the cached object.
 */
function cloneResult(
  result: BuildClientSkillsPayloadResult,
): BuildClientSkillsPayloadResult {
  return {
    clientSkills: result.clientSkills.map((s) => ({ ...s })),
    availableSkills: result.availableSkills.map((skill) => ({ ...skill })),
    skillPathById: { ...result.skillPathById },
    errors: result.errors.map((e) => ({ ...e })),
  };
}

/**
 * Invalidate the entire client skills payload cache.
 *
 * Useful when the process-wide skill configuration changes
 * (e.g. cwd switch, env var change, or global skill source update).
 */
export function invalidateClientSkillsPayloadCache(): void {
  advanceCacheGeneration();
  getCache().clear();
  invalidateAttachedRepositoriesCache();
}

/**
 * Invalidate cache entries for a specific agent.
 *
 * Useful when an agent's memory skills are updated (e.g. skill
 * creation/deletion via the Skill tool) and the next
 * `sendMessageStream` call must re-discover.
 */
export function invalidateClientSkillsPayloadCacheForAgent(
  agentId: string,
): void {
  advanceCacheGeneration();
  const cache = getCache();
  for (const [k, entry] of cache) {
    // The agentId is the first component of the key before the first "|".
    // We also check the stored entry for safety.
    if (entry.key.startsWith(`${agentId}|`) || k.startsWith(`${agentId}|`)) {
      cache.delete(k);
    }
  }
  invalidateAttachedRepositoriesCache(agentId);
}

// ---------------------------------------------------------------------------
// Skill discovery helpers
// ---------------------------------------------------------------------------

function getMemorySkillsDirs(agentId?: string): string[] {
  const dirs = new Set<string>();

  const scopedMemoryDir = resolveScopedMemoryDir({ agentId });
  if (
    scopedMemoryDir &&
    scopedMemoryDir.trim().length > 0 &&
    existsSync(scopedMemoryDir)
  ) {
    dirs.add(join(scopedMemoryDir.trim(), "skills"));
  } else {
    const fallbackMemoryDir = (
      process.env.LETTA_MEMORY_DIR ||
      process.env.MEMORY_DIR ||
      ""
    ).trim();
    if (fallbackMemoryDir) {
      dirs.add(join(fallbackMemoryDir, "skills"));
    }
  }

  return Array.from(dirs);
}

async function discoverMemorySkills(
  agentId?: string,
): Promise<SkillDiscoveryResult> {
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [];

  for (const dir of getMemorySkillsDirs(agentId)) {
    try {
      // Reuse the canonical skill parser by scanning this path as a project scope.
      // We remap source to "agent" so agent memory stays ahead of attached
      // shared memory, global skills, and bundled skills.
      const discovery = await discoverSkills(dir, undefined, {
        sources: ["project"],
        skipBundled: true,
      });
      errors.push(...discovery.errors);
      for (const skill of discovery.skills) {
        if (!skillsById.has(skill.id)) {
          skillsById.set(skill.id, { ...skill, source: "agent" });
        }
      }
    } catch (error) {
      errors.push({
        path: dir,
        message:
          error instanceof Error
            ? error.message
            : `Unknown error: ${String(error)}`,
      });
    }
  }

  return {
    skills: [...skillsById.values()].sort(compareSkills),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ClientSkill = NonNullable<
  ConversationMessageCreateParams["client_skills"]
>[number];

export interface BuildClientSkillsPayloadOptions {
  agentId?: string;
  workingDirectory?: string;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  attachedRepositories?: readonly AttachedAgentRepository[];
  discoverSkillsFn?: typeof discoverSkills;
  logger?: (message: string) => void;
}

export interface BuildClientSkillsPayloadResult {
  clientSkills: NonNullable<ConversationMessageCreateParams["client_skills"]>;
  availableSkills: AvailableSkillSummary[];
  skillPathById: Record<string, string>;
  errors: SkillDiscoveryError[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function toClientSkill(skill: Skill): ClientSkill {
  return {
    name: skill.id,
    description: skill.description,
    location: skill.path,
  };
}

function resolveSkillDiscoveryContext(
  options: BuildClientSkillsPayloadOptions,
): {
  workingDirectory: string;
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  skillSources: SkillSource[];
} {
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const configuredSkillsDirectory =
    options.skillsDirectory ?? getSkillsDirectory();
  const legacySkillsDirectory = join(workingDirectory, SKILLS_DIR);
  const primaryProjectSkillsDirectory = join(
    workingDirectory,
    PROJECT_SKILLS_DIR,
  );
  const skillSources = options.skillSources ?? getSkillSources();
  return {
    workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    skillSources,
  };
}

export interface DiscoverClientSideSkillsOptions {
  agentId?: string;
  workingDirectory?: string;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  attachedRepositories?: readonly AttachedAgentRepository[];
  discoverSkillsFn?: typeof discoverSkills;
}

interface CollectClientSideSkillsOptions
  extends DiscoverClientSideSkillsOptions {
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  sharedMemorySkillsDirs: string[];
  sharedMemoryErrors: SkillDiscoveryError[];
}

async function collectClientSideSkills(
  options: CollectClientSideSkillsOptions,
): Promise<SkillDiscoveryResult> {
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [...options.sharedMemoryErrors];

  const nonProjectSources =
    options.skillSources?.filter(
      (source): source is SkillSource => source !== "project",
    ) ?? [];

  const discoveryRuns: Array<{ path: string; sources: SkillSource[] }> = [];
  const discoveryRunKeys = new Set<string>();
  const addDiscoveryRun = (run: {
    path: string;
    sources: SkillSource[];
  }): void => {
    const key = `${resolve(run.path)}|${[...run.sources].sort().join(",")}`;
    if (discoveryRunKeys.has(key)) {
      return;
    }
    discoveryRunKeys.add(key);
    discoveryRuns.push(run);
  };

  if (nonProjectSources.length > 0) {
    addDiscoveryRun({
      path: options.primaryProjectSkillsDirectory,
      sources: nonProjectSources,
    });
  }

  const includeProjectSource =
    options.skillSources?.includes("project") ?? false;

  if (
    includeProjectSource &&
    options.configuredSkillsDirectory &&
    options.configuredSkillsDirectory !== options.legacySkillsDirectory &&
    options.configuredSkillsDirectory !== options.primaryProjectSkillsDirectory
  ) {
    addDiscoveryRun({
      path: options.configuredSkillsDirectory,
      sources: ["project"],
    });
  }

  if (
    includeProjectSource &&
    options.legacySkillsDirectory !== options.primaryProjectSkillsDirectory
  ) {
    addDiscoveryRun({
      path: options.legacySkillsDirectory,
      sources: ["project"],
    });
  }

  if (includeProjectSource) {
    addDiscoveryRun({
      path: options.primaryProjectSkillsDirectory,
      sources: ["project"],
    });
  }

  for (const run of discoveryRuns) {
    try {
      const discovery = await discoverSkillsFn(run.path, options.agentId, {
        sources: run.sources,
      });
      errors.push(...discovery.errors);
      for (const skill of discovery.skills) {
        if (isSkillAvailableForAgent(skill, options.agentId)) {
          skillsById.set(skill.id, skill);
        }
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      errors.push({ path: run.path, message });
    }
  }

  if ((options.skillSources?.length ?? 0) > 0) {
    const memoryDiscovery = await discoverMemorySkills(options.agentId);
    errors.push(...memoryDiscovery.errors);
    for (const skill of memoryDiscovery.skills) {
      if (!isSkillAvailableForAgent(skill, options.agentId)) {
        continue;
      }
      const existing = skillsById.get(skill.id);
      if (existing?.source === "project" || existing?.source === "agent") {
        continue;
      }
      skillsById.set(skill.id, skill);
    }

    const sharedMemoryDiscovery = await discoverSharedMemorySkills(
      options.sharedMemorySkillsDirs,
    );
    errors.push(...sharedMemoryDiscovery.errors);
    for (const skill of sharedMemoryDiscovery.skills) {
      if (!isSkillAvailableForAgent(skill, options.agentId)) {
        continue;
      }
      const existing = skillsById.get(skill.id);
      if (existing?.source === "project" || existing?.source === "agent") {
        continue;
      }
      skillsById.set(skill.id, skill);
    }
  }

  return {
    skills: [...skillsById.values()].sort(compareSkills),
    errors,
  };
}

/**
 * Discover all client-side skills from the same roots used for `client_skills`.
 * This intentionally returns both model-invocable and manual-only skills; callers
 * decide whether to filter for model invocation or slash-command invocation.
 */
export async function discoverClientSideSkills(
  options: DiscoverClientSideSkillsOptions = {},
): Promise<SkillDiscoveryResult> {
  const {
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    skillSources,
  } = resolveSkillDiscoveryContext(options);
  const sharedMemoryContext = await resolveSharedMemorySkillsContext({
    agentId: options.agentId,
    skillSources,
    attachedRepositories: options.attachedRepositories,
  });
  return collectClientSideSkills({
    ...options,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    skillSources,
    primaryProjectSkillsDirectory,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
    sharedMemoryErrors: sharedMemoryContext.errors,
  });
}

// ---------------------------------------------------------------------------
// Core function (with cache)
// ---------------------------------------------------------------------------

/**
 * Build `client_skills` payload for conversations.messages.create.
 *
 * This discovers client-side skills using the same source selection rules as the
 * Skill tool and headless startup flow, then converts them into the server-facing
 * schema expected by the API. Ordering is deterministic by skill id.
 *
 * Results are cached in-memory keyed by agent id, skill sources, cwd, and
 * resolved skill roots so that repeated calls (e.g. during approval
 * continuations) skip redundant filesystem discovery.
 */
export async function buildClientSkillsPayload(
  options: BuildClientSkillsPayloadOptions = {},
): Promise<BuildClientSkillsPayloadResult> {
  const {
    workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    skillSources,
  } = resolveSkillDiscoveryContext(options);
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;

  // When a custom discoverSkillsFn is provided (tests / DI), bypass the cache
  // so the injected function is always called.
  const useCache = !options.discoverSkillsFn;

  const memorySkillsDirs = getMemorySkillsDirs(options.agentId);
  const sharedMemoryContext = await resolveSharedMemorySkillsContext({
    agentId: options.agentId,
    skillSources,
    attachedRepositories: options.attachedRepositories,
  });
  const skillRoots = getSkillRoots({
    agentId: options.agentId,
    skillSources,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    memorySkillsDirs,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
  });
  if (useCache && shouldStartSkillWatchers()) {
    getWatcher().ensureRoots(skillRoots);
  }
  const cacheComponents = {
    agentId: options.agentId,
    skillSources,
    cwd: workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    memorySkillsDirs,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
    sharedMemoryErrors: sharedMemoryContext.errors,
  };
  const cacheKey = computeCacheKey(cacheComponents);

  if (useCache) {
    const cache = getCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      return cloneResult(cached.result);
    }
  }

  const generationBeforeDiscovery = getCacheGeneration();
  const discovery = await collectClientSideSkills({
    ...options,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    skillSources,
    primaryProjectSkillsDirectory,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
    sharedMemoryErrors: sharedMemoryContext.errors,
    discoverSkillsFn,
  });
  const errors = discovery.errors;

  const sortedSkills = discovery.skills.filter(isModelInvocableSkill);

  if (errors.length > 0) {
    const summarizedErrors = errors.map(
      (error) => `${error.path}: ${error.message}`,
    );
    options.logger?.(
      `Failed to build some client_skills entries: ${summarizedErrors.join("; ")}`,
    );
  }

  const result: BuildClientSkillsPayloadResult = {
    clientSkills: sortedSkills.map(toClientSkill),
    availableSkills: sortedSkills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      path: skill.path,
      source: skill.source,
    })),
    skillPathById: Object.fromEntries(
      sortedSkills
        .filter(
          (skill) => typeof skill.path === "string" && skill.path.length > 0,
        )
        .map((skill) => [skill.id, skill.path]),
    ),
    errors,
  };

  if (useCache && generationBeforeDiscovery === getCacheGeneration()) {
    getCache().set(cacheKey, { key: cacheKey, result: cloneResult(result) });
  }

  return result;
}
