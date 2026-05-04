import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { getSkillSources, getSkillsDirectory } from "./context";
import { resolveScopedMemoryDir } from "./memoryFilesystem";
import {
  compareSkills,
  discoverSkills,
  GLOBAL_SKILLS_DIR,
  getAgentSkillsDir,
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

interface CacheEntry {
  key: string;
  result: BuildClientSkillsPayloadResult;
}

type ClientSkillsCache = Map<string, CacheEntry>;

type GlobalWithClientSkillsCache = typeof globalThis & {
  [key: symbol]: ClientSkillsCache | undefined;
};

function getCache(): ClientSkillsCache {
  const global = globalThis as GlobalWithClientSkillsCache;
  if (!global[CLIENT_SKILLS_CACHE_KEY]) {
    global[CLIENT_SKILLS_CACHE_KEY] = new Map();
  }
  return global[CLIENT_SKILLS_CACHE_KEY] as ClientSkillsCache;
}

/**
 * Compute a cache key from the parameters that influence skill discovery.
 *
 * We include:
 *  - agentId
 *  - sorted skill sources
 *  - cwd (affects `.agents/skills` and `.skills` resolution)
 *  - legacy skills directory
 *  - primary project skills directory
 *  - resolved memory skills dirs (scoped or env-fallback)
 *
 * This is conservative: any change in these inputs produces a cache miss,
 * ensuring correctness while still caching the common case where nothing
 * changes between `sendMessageStream` calls.
 */
function computeCacheKey(components: {
  agentId: string | undefined;
  skillSources: SkillSource[];
  cwd: string;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  memorySkillsDirs: string[];
  skillRootRevisions: string[];
}): string {
  return [
    components.agentId ?? "",
    [...components.skillSources].sort().join(","),
    components.cwd,
    components.legacySkillsDirectory,
    components.primaryProjectSkillsDirectory,
    [...components.memorySkillsDirs].sort().join(","),
    [...components.skillRootRevisions].sort().join(","),
  ].join("|");
}

function getSkillDirectoryRevision(
  root: string,
  visitedRealPaths: Set<string> = new Set(),
): string {
  const normalizedRoot = root.trim();
  if (normalizedRoot.length === 0) {
    return "empty";
  }

  try {
    const rootStat = statSync(normalizedRoot);
    const realPath = realpathSync(normalizedRoot);
    if (visitedRealPaths.has(realPath)) {
      return `${normalizedRoot}:cycle`;
    }
    visitedRealPaths.add(realPath);

    if (!rootStat.isDirectory()) {
      return `${normalizedRoot}:file:${rootStat.mtimeMs}:${rootStat.size}`;
    }

    const entries = readdirSync(normalizedRoot, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    const parts = [`${realPath}:dir:${rootStat.mtimeMs}:${rootStat.size}`];

    for (const entry of entries) {
      const fullPath = join(normalizedRoot, entry.name);
      try {
        if (entry.isDirectory()) {
          parts.push(
            `${entry.name}/(${getSkillDirectoryRevision(fullPath, visitedRealPaths)})`,
          );
          continue;
        }

        const isSkillFile = entry.name.toUpperCase() === "SKILL.MD";
        if (entry.isSymbolicLink()) {
          const targetStat = statSync(fullPath);
          if (targetStat.isDirectory()) {
            parts.push(
              `${entry.name}@(${getSkillDirectoryRevision(fullPath, visitedRealPaths)})`,
            );
          } else if (isSkillFile) {
            parts.push(
              `${entry.name}:${targetStat.mtimeMs}:${targetStat.size}`,
            );
          }
          continue;
        }

        if (entry.isFile() && isSkillFile) {
          const fileStat = statSync(fullPath);
          parts.push(`${entry.name}:${fileStat.mtimeMs}:${fileStat.size}`);
        }
      } catch (error) {
        parts.push(
          `${entry.name}:error:${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return parts.join(",");
  } catch (error) {
    return `${normalizedRoot}:missing:${error instanceof Error ? error.message : String(error)}`;
  }
}

function getSkillRootRevisions(components: {
  agentId: string | undefined;
  skillSources: SkillSource[];
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  memorySkillsDirs: string[];
}): string[] {
  const roots = new Set<string>();
  const sourceSet = new Set(components.skillSources);

  if (sourceSet.has("project")) {
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
  }

  return [...roots].map((root) => `${root}=${getSkillDirectoryRevision(root)}`);
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
  getCache().clear();
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
  const cache = getCache();
  for (const [k, entry] of cache) {
    // The agentId is the first component of the key before the first "|".
    // We also check the stored entry for safety.
    if (entry.key.startsWith(`${agentId}|`) || k.startsWith(`${agentId}|`)) {
      cache.delete(k);
    }
  }
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
      // We remap source to "agent" because memory skill precedence should be:
      // project > agent > memory > global > bundled.
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
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  discoverSkillsFn?: typeof discoverSkills;
  logger?: (message: string) => void;
}

export interface BuildClientSkillsPayloadResult {
  clientSkills: NonNullable<ConversationMessageCreateParams["client_skills"]>;
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
  legacySkillsDirectory: string;
  skillSources: SkillSource[];
} {
  const legacySkillsDirectory =
    options.skillsDirectory ??
    getSkillsDirectory() ??
    join(process.cwd(), SKILLS_DIR);
  const skillSources = options.skillSources ?? getSkillSources();
  return { legacySkillsDirectory, skillSources };
}

function getPrimaryProjectSkillsDirectory(): string {
  return join(process.cwd(), ".agents", "skills");
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
  const { legacySkillsDirectory, skillSources } =
    resolveSkillDiscoveryContext(options);
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;

  // When a custom discoverSkillsFn is provided (tests / DI), bypass the cache
  // so the injected function is always called.
  const useCache = !options.discoverSkillsFn;

  const cwd = process.cwd();
  const primaryProjectSkillsDirectory = getPrimaryProjectSkillsDirectory();
  const memorySkillsDirs = getMemorySkillsDirs(options.agentId);
  const cacheComponents = {
    agentId: options.agentId,
    skillSources,
    cwd,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    memorySkillsDirs,
    skillRootRevisions: getSkillRootRevisions({
      agentId: options.agentId,
      skillSources,
      legacySkillsDirectory,
      primaryProjectSkillsDirectory,
      memorySkillsDirs,
    }),
  };
  const cacheKey = computeCacheKey(cacheComponents);

  if (useCache) {
    const cache = getCache();
    const cached = cache.get(cacheKey);
    if (cached) {
      return cloneResult(cached.result);
    }
  }

  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [];

  const nonProjectSources = skillSources.filter(
    (source): source is SkillSource => source !== "project",
  );

  const discoveryRuns: Array<{ path: string; sources: SkillSource[] }> = [];

  // For bundled/global/agent sources, use the primary project root.
  if (nonProjectSources.length > 0) {
    discoveryRuns.push({
      path: primaryProjectSkillsDirectory,
      sources: nonProjectSources,
    });
  }

  const includeProjectSource = skillSources.includes("project");

  // Legacy project location (.skills): discovered first so primary path can override.
  if (
    includeProjectSource &&
    legacySkillsDirectory !== primaryProjectSkillsDirectory
  ) {
    discoveryRuns.push({
      path: legacySkillsDirectory,
      sources: ["project"],
    });
  }

  // Primary location for project-scoped client skills.
  if (includeProjectSource) {
    discoveryRuns.push({
      path: primaryProjectSkillsDirectory,
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
        skillsById.set(skill.id, skill);
      }
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : `Unknown error: ${String(error)}`;
      errors.push({ path: run.path, message });
    }
  }

  // MemFS skills are discovered by the Skill tool, so include them in
  // client_skills as well. This keeps the model's available-skills list in
  // sync with actual Skill(...) resolution in desktop/listen mode.
  if (skillSources.length > 0) {
    const memoryDiscovery = await discoverMemorySkills(options.agentId);
    errors.push(...memoryDiscovery.errors);
    for (const skill of memoryDiscovery.skills) {
      const existing = skillsById.get(skill.id);

      // Preserve higher-priority skills: project and agent-scoped.
      // MemFS should override only global/bundled or fill missing ids.
      if (existing?.source === "project" || existing?.source === "agent") {
        continue;
      }

      skillsById.set(skill.id, skill);
    }
  }

  const sortedSkills = [...skillsById.values()].sort(compareSkills);

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
    skillPathById: Object.fromEntries(
      sortedSkills
        .filter(
          (skill) => typeof skill.path === "string" && skill.path.length > 0,
        )
        .map((skill) => [skill.id, skill.path]),
    ),
    errors,
  };

  if (useCache) {
    getCache().set(cacheKey, { key: cacheKey, result: cloneResult(result) });
  }

  return result;
}
