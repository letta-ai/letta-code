import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isCheckoutPending } from "@/utils/checkout-readiness";
import { isLocalAgentId } from "./agent-id";
import type { AttachedAgentRepository } from "./attached-repositories";
import {
  compareSkills,
  discoverSkills,
  type Skill,
  type SkillDiscoveryError,
  type SkillDiscoveryResult,
  type SkillSource,
} from "./skills";
import { resolveEffectiveAgentId } from "./subagents/ephemeral-subagent";

const ATTACHED_REPOSITORIES_CACHE_KEY = Symbol.for(
  "@letta/attachedRepositoriesCache",
);
const ATTACHED_REPOSITORIES_CACHE_TTL_MS = 5_000;
const LAST_GOOD_ATTACHED_REPOSITORIES_KEY = Symbol.for(
  "@letta/lastGoodAttachedRepositories",
);

interface AttachedRepositoriesCacheEntry {
  expiresAt: number;
  promise: Promise<AttachedAgentRepository[]>;
}

type AttachedRepositoriesCache = Map<string, AttachedRepositoriesCacheEntry>;

type GlobalWithAttachedRepositories = typeof globalThis & {
  [ATTACHED_REPOSITORIES_CACHE_KEY]?: AttachedRepositoriesCache;
  [LAST_GOOD_ATTACHED_REPOSITORIES_KEY]?: Map<
    string,
    AttachedAgentRepository[]
  >;
};

/**
 * Last successful repository list per agent. Unlike the TTL cache, this is
 * never expired or invalidated: a failed fetch falls back to it so a transient
 * error does not drop every attached-repo skill for one request (which churns
 * the prompt prefix and emits spurious skill reminders). Only another
 * successful response replaces it.
 */
function getLastGoodAttachedRepositories(): Map<
  string,
  AttachedAgentRepository[]
> {
  const global = globalThis as GlobalWithAttachedRepositories;
  if (!global[LAST_GOOD_ATTACHED_REPOSITORIES_KEY]) {
    global[LAST_GOOD_ATTACHED_REPOSITORIES_KEY] = new Map();
  }
  return global[LAST_GOOD_ATTACHED_REPOSITORIES_KEY];
}

function getAttachedRepositoriesCache(): AttachedRepositoriesCache {
  const global = globalThis as GlobalWithAttachedRepositories;
  if (!global[ATTACHED_REPOSITORIES_CACHE_KEY]) {
    global[ATTACHED_REPOSITORIES_CACHE_KEY] = new Map();
  }
  return global[ATTACHED_REPOSITORIES_CACHE_KEY];
}

export function invalidateAttachedRepositoriesCache(agentId?: string): void {
  if (agentId) {
    getAttachedRepositoriesCache().delete(agentId);
    return;
  }
  getAttachedRepositoriesCache().clear();
}

async function getAttachedRepositories(
  agentId: string,
): Promise<AttachedAgentRepository[]> {
  const cache = getAttachedRepositoriesCache();
  const cached = cache.get(agentId);
  if (cached && cached.expiresAt > Date.now()) {
    return (await cached.promise).map((repository) => ({ ...repository }));
  }

  const promise = import("./attached-repositories").then(
    async ({ listAttachedAgentRepositories }) =>
      (
        await listAttachedAgentRepositories(resolveEffectiveAgentId(agentId))
      ).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
  );
  const entry = {
    expiresAt: Date.now() + ATTACHED_REPOSITORIES_CACHE_TTL_MS,
    promise,
  };
  cache.set(agentId, entry);

  try {
    const repositories = await promise;
    if (cache.get(agentId) === entry) {
      getLastGoodAttachedRepositories().set(
        agentId,
        repositories.map((repository) => ({ ...repository })),
      );
    }
    return repositories.map((repository) => ({ ...repository }));
  } catch (error) {
    if (cache.get(agentId) === entry) {
      cache.delete(agentId);
    }
    throw error;
  }
}

export interface SharedMemorySkillsContext {
  skillsDirs: string[];
  errors: SkillDiscoveryError[];
}

/**
 * Resolve only server-attached repository mounts. Local sibling directories are
 * deliberately ignored because detach leaves their checkouts on disk.
 */
export async function resolveSharedMemorySkillsContext(options: {
  agentId?: string;
  skillSources: SkillSource[];
  attachedRepositories?: readonly AttachedAgentRepository[];
}): Promise<SharedMemorySkillsContext> {
  const agentId = options.agentId?.trim();
  if (
    !agentId ||
    isLocalAgentId(agentId) ||
    options.skillSources.length === 0
  ) {
    return { skillsDirs: [], errors: [] };
  }

  let repositories: AttachedAgentRepository[];
  let fetchError: SkillDiscoveryError | undefined;
  if (options.attachedRepositories) {
    repositories = options.attachedRepositories.map((repository) => ({
      ...repository,
    }));
  } else {
    const { isLettaCloud } = await import("./memory-filesystem");
    try {
      if (!(await isLettaCloud())) {
        return { skillsDirs: [], errors: [] };
      }
    } catch {
      // This can run before settings initialization in tests and early startup.
      return { skillsDirs: [], errors: [] };
    }
    try {
      repositories = await getAttachedRepositories(agentId);
    } catch (error) {
      fetchError = {
        path: `shared-memory:${agentId}`,
        message: `Failed to list attached repositories: ${error instanceof Error ? error.message : String(error)}`,
      };
      const lastGood = getLastGoodAttachedRepositories().get(agentId);
      if (!lastGood) {
        return { skillsDirs: [], errors: [fetchError] };
      }
      repositories = lastGood.map((repository) => ({ ...repository }));
    }
  }

  const errors: SkillDiscoveryError[] = fetchError ? [fetchError] : [];
  const skillsDirs: string[] = [];
  const { getRepositoryMountDir, validateAgentRepositoryName } = await import(
    "./memory-git"
  );
  for (const repository of repositories.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  )) {
    try {
      const repositoryName = validateAgentRepositoryName(repository.name);
      skillsDirs.push(
        join(getRepositoryMountDir(agentId, repositoryName), "skills"),
      );
    } catch (error) {
      errors.push({
        path: `shared-memory:${repository.name}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { skillsDirs, errors };
}

export async function discoverSharedMemorySkills(
  skillsDirs: string[],
): Promise<SkillDiscoveryResult> {
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [];

  for (const dir of skillsDirs) {
    const repositoryMount = dirname(dir);
    if (isCheckoutPending(repositoryMount)) continue;
    if (!existsSync(repositoryMount)) {
      errors.push({
        path: repositoryMount,
        message: "Attached repository is not mounted locally",
      });
      continue;
    }

    try {
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
