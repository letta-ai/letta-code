import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MessageCreateParams as ConversationMessageCreateParams } from "@letta-ai/letta-client/resources/conversations/messages";
import { getRuntimeContext } from "@/runtime-context";
import type { AvailableSkillSummary } from "@/types/protocol_v2";
import { getCheckoutGeneration } from "@/utils/checkout-readiness";
import { cloudRepositoryRoots } from "@/utils/cloud-repository-roots";
import type { AttachedAgentRepository } from "./attached-repositories";
import { ClientSkillsWatcher } from "./client-skills-watcher";
import {
  getBundledSkillAllowlist,
  getSkillSources,
  getSkillsDirectory,
} from "./context";
import { resolveScopedMemoryDir } from "./memory-filesystem";
import {
  discoverSharedMemorySkills,
  invalidateAttachedRepositoriesCache,
  resolveSharedMemorySkillsContext,
} from "./shared-memory-skills";
import {
  compareSkills,
  discoverSkills,
  getAgentSkillsDir,
  getGlobalSkillsDir,
  isModelInvocableSkill,
  isSkillAvailableForAgent,
  PROJECT_SKILLS_DIR,
  SKILLS_DIR,
  type Skill,
  type SkillDiscoveryError,
  type SkillDiscoveryResult,
  type SkillSource,
} from "./skills";

const CLIENT_SKILLS_CACHE_KEY = Symbol.for("@letta/clientSkillsCache");
const CLIENT_SKILLS_CACHE_GENERATION_KEY = Symbol.for(
  "@letta/clientSkillsCacheGeneration",
);
const CLIENT_SKILLS_WATCHER_KEY = Symbol.for("@letta/clientSkillsWatcher");

interface CacheEntry {
  key: string;
  result: BuildClientSkillsPayloadResult;
  checkoutGeneration: number;
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

function computeCacheKey(components: {
  agentId: string | undefined;
  skillSources: SkillSource[];
  bundledSkills: string[] | undefined;
  cwd: string;
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  extraProjectSkillsDirectories: string[];
  memorySkillsDirs: string[];
  sharedMemorySkillsDirs: string[];
  sharedMemoryErrors: SkillDiscoveryError[];
}): string {
  return [
    components.agentId ?? "",
    [...components.skillSources].sort().join(","),
    components.bundledSkills
      ? [...components.bundledSkills].sort().join(",")
      : "*",
    components.cwd,
    components.configuredSkillsDirectory ?? "",
    components.legacySkillsDirectory,
    components.primaryProjectSkillsDirectory,
    JSON.stringify(components.extraProjectSkillsDirectories),
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
  extraProjectSkillsDirectories: string[];
  memorySkillsDirs: string[];
  sharedMemorySkillsDirs: string[];
}): string[] {
  const roots = new Set<string>();
  const sourceSet = new Set(components.skillSources);

  if (sourceSet.has("project")) {
    if (components.configuredSkillsDirectory) {
      roots.add(components.configuredSkillsDirectory);
    }
    for (const root of components.extraProjectSkillsDirectories)
      roots.add(root);
    roots.add(components.legacySkillsDirectory);
    roots.add(components.primaryProjectSkillsDirectory);
  }
  if (sourceSet.has("global")) {
    roots.add(getGlobalSkillsDir());
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

export function invalidateClientSkillsPayloadCache(): void {
  advanceCacheGeneration();
  getCache().clear();
  invalidateAttachedRepositoriesCache();
}

export function invalidateClientSkillsPayloadCacheForAgent(
  agentId: string,
): void {
  advanceCacheGeneration();
  const cache = getCache();
  for (const [k, entry] of cache) {
    if (entry.key.startsWith(`${agentId}|`) || k.startsWith(`${agentId}|`)) {
      cache.delete(k);
    }
  }
  invalidateAttachedRepositoriesCache(agentId);
}

export function buildClientSkillsUpdateReminder(
  previous: BuildClientSkillsPayloadResult["clientSkills"] | undefined,
  current: BuildClientSkillsPayloadResult["clientSkills"],
): string | null {
  if (!previous) return null;
  const previousByName = new Map(previous.map((skill) => [skill.name, skill]));
  const currentNames = new Set(current.map((skill) => skill.name));
  const added = current.filter((skill) => !previousByName.has(skill.name));
  const updated = current.filter((skill) => {
    const old = previousByName.get(skill.name);
    return (
      old !== undefined &&
      (old.description !== skill.description || old.location !== skill.location)
    );
  });
  const removed = previous
    .filter((skill) => !currentNames.has(skill.name))
    .map((skill) => skill.name);
  if (added.length === 0 && updated.length === 0 && removed.length === 0) {
    return null;
  }

  const escapeXml = (text: string): string =>
    text
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#x27;");
  const skillList = (
    heading: string,
    skills: BuildClientSkillsPayloadResult["clientSkills"],
  ): string[] =>
    skills.length === 0
      ? []
      : [
          heading,
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            `    <name>${escapeXml(skill.name)}</name>`,
            `    <description>${escapeXml(skill.description)}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ];
  return [
    "<system-reminder>",
    "The available skills have changed. This update supersedes the skills list in your system prompt and any earlier skill update.",
    ...skillList("Added skills:", added),
    ...skillList("Updated skills:", updated),
    ...(removed.length > 0
      ? [
          "Removed skills (do not use these, even if they still appear in your system prompt):",
          ...removed.map((name) => `- ${escapeXml(name)}`),
        ]
      : []),
    "Current skills (complete list; skills not described above keep the descriptions you already have):",
    ...(current.length > 0
      ? current.map((skill) => `- ${escapeXml(skill.name)}`)
      : ["(none)"]),
    "</system-reminder>",
  ].join("\n");
}

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

export type ClientSkill = NonNullable<
  ConversationMessageCreateParams["client_skills"]
>[number];

export interface BuildClientSkillsPayloadOptions {
  agentId?: string;
  workingDirectory?: string;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  bundledSkills?: string[];
  attachedRepositories?: readonly AttachedAgentRepository[];
  cloudSkillRepositories?: readonly string[];
  discoverSkillsFn?: typeof discoverSkills;
  logger?: (message: string) => void;
}

export interface BuildClientSkillsPayloadResult {
  clientSkills: NonNullable<ConversationMessageCreateParams["client_skills"]>;
  availableSkills: AvailableSkillSummary[];
  skillPathById: Record<string, string>;
  errors: SkillDiscoveryError[];
}

function toClientSkill(skill: Skill): ClientSkill {
  return {
    name: skill.id,
    description: skill.description,
    location: skill.path,
  };
}

export function getCloudProjectSkillDirectories(
  repositories: readonly string[] | undefined = getRuntimeContext()
    ?.executionSettings?.cloud_skill_repositories,
): string[] {
  const roots = cloudRepositoryRoots(repositories);
  return roots.flatMap((root) => [
    join(root, SKILLS_DIR),
    join(root, PROJECT_SKILLS_DIR),
  ]);
}

function resolveSkillDiscoveryContext(
  options: BuildClientSkillsPayloadOptions,
): {
  workingDirectory: string;
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  extraProjectSkillsDirectories: string[];
  skillSources: SkillSource[];
  bundledSkills: string[] | undefined;
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
  const bundledSkills = skillSources.includes("bundled")
    ? undefined
    : (options.bundledSkills ?? getBundledSkillAllowlist());
  return {
    workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories: getCloudProjectSkillDirectories(
      options.cloudSkillRepositories,
    ),
    skillSources,
    bundledSkills,
  };
}

export interface DiscoverClientSideSkillsOptions {
  agentId?: string;
  workingDirectory?: string;
  skillsDirectory?: string | null;
  skillSources?: SkillSource[];
  bundledSkills?: string[];
  attachedRepositories?: readonly AttachedAgentRepository[];
  cloudSkillRepositories?: readonly string[];
  discoverSkillsFn?: typeof discoverSkills;
}

interface CollectClientSideSkillsOptions
  extends DiscoverClientSideSkillsOptions {
  configuredSkillsDirectory: string | null;
  legacySkillsDirectory: string;
  primaryProjectSkillsDirectory: string;
  extraProjectSkillsDirectories: string[];
  sharedMemorySkillsDirs: string[];
  sharedMemoryErrors: SkillDiscoveryError[];
}

async function collectClientSideSkills(
  options: CollectClientSideSkillsOptions,
): Promise<SkillDiscoveryResult> {
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;
  const skillsById = new Map<string, Skill>();
  const errors: SkillDiscoveryError[] = [...options.sharedMemoryErrors];

  if (options.bundledSkills?.length) {
    const allowed = new Set(options.bundledSkills);
    try {
      const discovery = await discoverSkillsFn(
        options.primaryProjectSkillsDirectory,
        options.agentId,
        { sources: ["bundled"] },
      );
      errors.push(...discovery.errors);
      for (const skill of discovery.skills) {
        if (
          allowed.has(skill.id) &&
          isSkillAvailableForAgent(skill, options.agentId)
        ) {
          skillsById.set(skill.id, skill);
        }
      }
    } catch (error) {
      errors.push({
        path: "bundled",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

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

  if (includeProjectSource) {
    for (const path of options.extraProjectSkillsDirectories)
      addDiscoveryRun({ path, sources: ["project"] });
  }

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

export async function discoverClientSideSkills(
  options: DiscoverClientSideSkillsOptions = {},
): Promise<SkillDiscoveryResult> {
  const {
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories,
    skillSources,
    bundledSkills,
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
    bundledSkills,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
    sharedMemoryErrors: sharedMemoryContext.errors,
  });
}

export async function buildClientSkillsPayload(
  options: BuildClientSkillsPayloadOptions = {},
): Promise<BuildClientSkillsPayloadResult> {
  const {
    workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories,
    skillSources,
    bundledSkills,
  } = resolveSkillDiscoveryContext(options);
  const discoverSkillsFn = options.discoverSkillsFn ?? discoverSkills;

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
    extraProjectSkillsDirectories,
    memorySkillsDirs,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
  });
  if (useCache && shouldStartSkillWatchers()) {
    getWatcher().ensureRoots(skillRoots);
  }
  const cacheComponents = {
    agentId: options.agentId,
    skillSources,
    bundledSkills,
    cwd: workingDirectory,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories,
    memorySkillsDirs,
    sharedMemorySkillsDirs: sharedMemoryContext.skillsDirs,
    sharedMemoryErrors: sharedMemoryContext.errors,
  };
  const cacheKey = computeCacheKey(cacheComponents);

  if (useCache) {
    const cache = getCache();
    const cached = cache.get(cacheKey);
    if (cached && cached.checkoutGeneration === getCheckoutGeneration()) {
      return cloneResult(cached.result);
    }
  }

  const generationBeforeDiscovery = getCacheGeneration();
  const checkoutGenerationBeforeDiscovery = getCheckoutGeneration();
  const discovery = await collectClientSideSkills({
    ...options,
    configuredSkillsDirectory,
    legacySkillsDirectory,
    skillSources,
    bundledSkills,
    primaryProjectSkillsDirectory,
    extraProjectSkillsDirectories,
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
      discovery.skills
        .filter(
          (skill) => typeof skill.path === "string" && skill.path.length > 0,
        )
        .map((skill) => [skill.id, skill.path]),
    ),
    errors,
  };

  if (
    useCache &&
    generationBeforeDiscovery === getCacheGeneration() &&
    checkoutGenerationBeforeDiscovery === getCheckoutGeneration()
  ) {
    getCache().set(cacheKey, {
      key: cacheKey,
      result: cloneResult(result),
      checkoutGeneration: getCheckoutGeneration(),
    });
  }

  return result;
}
