/**
 * Subagent configuration, discovery, and management
 *
 * Built-in subagents are bundled with the package.
 * Users can also define custom subagents as Markdown files with YAML frontmatter
 * in the .letta/agents/ directory.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getBackend } from "@/backend";
import { getErrorMessage } from "@/utils/error";
import {
  getStringField,
  parseCommaSeparatedList,
  parseFrontmatter,
} from "@/utils/frontmatter";
// Built-in subagent definitions (embedded at build time)
import forkAgentMd from "./builtin/fork.md";
import generalPurposeAgentMd from "./builtin/general-purpose.md";
import historyAnalyzerAgentMd from "./builtin/history-analyzer.md";
import initAgentMd from "./builtin/init.md";
import memoryAgentMd from "./builtin/memory.md";
import recallAgentMd from "./builtin/recall.md";
import reflectionAgentMd from "./builtin/reflection.md";

const STANDARD_BUILTIN_SOURCES = [
  forkAgentMd,
  generalPurposeAgentMd,
  historyAnalyzerAgentMd,
  initAgentMd,
  memoryAgentMd,
  recallAgentMd,
  reflectionAgentMd,
];

const LOCAL_MEMFS_BUILTIN_SOURCES = [
  forkAgentMd,
  generalPurposeAgentMd,
  historyAnalyzerAgentMd,
  initAgentMd,
  memoryAgentMd,
  recallAgentMd,
  reflectionAgentMd,
];

// ============================================================================
// Types
// ============================================================================

/**
 * Subagent configuration
 */
export type SubagentLaunchProfile = "default" | "memory-subagent";
export type SubagentRecommendedModelSource = "builtin" | "user";

/** Exact memory scope handed to a harness-created memory worktree. */
export interface SubagentMemoryScope {
  primaryRoot: string | null;
  writableRoots: string[];
  readonlyRoots?: string[];
}

/**
 * Subagent execution result
 */
export interface SubagentResult {
  agentId: string;
  conversationId?: string;
  model?: string;
  report: string;
  success: boolean;
  error?: string;
  totalTokens?: number;
  stepCount?: number;
  durationMs?: number;
}

export interface SubagentConfig {
  /** Unique identifier for the subagent */
  name: string;
  /** Description of when to use this subagent */
  description: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /** Allowed tools - specific list or "all" (invalid names are ignored at runtime) */
  allowedTools: string[] | "all";
  /** Recommended model - any runtime catalog ID or full handle */
  recommendedModel: string;
  /** Whether the recommended model came from bundled defaults or user config. */
  recommendedModelSource?: SubagentRecommendedModelSource;
  /** Skills to auto-load */
  skills: string[];
  /** Whether this subagent should fork the parent conversation before launch. */
  fork: boolean;
  /** Whether this subagent should run in the background by default. */
  background: boolean;
  /** Filesystem and env launch behavior for this subagent. */
  launchProfile: SubagentLaunchProfile;
}

/**
 * Result of subagent discovery
 */
export interface SubagentDiscoveryResult {
  subagents: SubagentConfig[];
  errors: Array<{ path: string; message: string }>;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Directory for subagent files (relative to project root)
 */
export const AGENTS_DIR = ".letta/agents";

/**
 * Global directory for subagent files (in user's home directory)
 */
function getGlobalAgentsDir(): string {
  return join(
    process.env.HOME || process.env.USERPROFILE || "~",
    ".letta/agents",
  );
}

export const GLOBAL_AGENTS_DIR = getGlobalAgentsDir();

// ============================================================================
// Cache
// ============================================================================

/**
 * Consolidated cache for subagent configurations
 * - builtins: parsed once from bundled markdown, never changes
 * - configs: builtins + custom agents, invalidated when workingDir changes
 */
const cache = {
  builtins: {
    standard: null as Record<string, SubagentConfig> | null,
    localMemfs: null as Record<string, SubagentConfig> | null,
  },
  configs: null as Record<string, SubagentConfig> | null,
  workingDir: null as string | null,
  localMemfs: null as boolean | null,
};

// ============================================================================
// Parsing Helpers
// ============================================================================

/**
 * Validate a subagent name
 */
function isValidName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Parse comma-separated tools string
 * Invalid tool names are kept - they'll be filtered out at runtime when matching against actual tools
 */
function parseTools(toolsStr: string | undefined): string[] | "all" {
  if (
    !toolsStr ||
    toolsStr.trim() === "" ||
    toolsStr.trim().toLowerCase() === "all"
  ) {
    return "all";
  }
  const tools = parseCommaSeparatedList(toolsStr);
  return tools.length > 0 ? tools : "all";
}

/**
 * Parse comma-separated skills string
 */
function parseSkills(skillsStr: string | undefined): string[] {
  return parseCommaSeparatedList(skillsStr);
}

function parseLaunchProfile(
  launchProfile: string | undefined,
): SubagentLaunchProfile {
  return launchProfile === "memory-subagent" ? "memory-subagent" : "default";
}

function parseBackgroundDefault(background: string | undefined): boolean {
  return background?.toLowerCase() !== "false";
}

/**
 * Validate subagent frontmatter
 * Only validates required fields - optional fields are validated at runtime where needed
 */
function validateFrontmatter(
  frontmatter: Record<string, string | string[]>,
  options: { requireDescription?: boolean } = {},
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check required fields only
  const name = frontmatter.name;
  if (!name || typeof name !== "string") {
    errors.push("Missing required field: name");
  } else if (!isValidName(name)) {
    errors.push(
      `Invalid name "${name}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    );
  }

  const description = frontmatter.description;
  if (options.requireDescription !== false) {
    if (!description || typeof description !== "string") {
      errors.push("Missing required field: description");
    }
  }

  // Don't validate model or launchProfile here - they're handled at runtime:
  // - model: resolveModel() returns null for invalid values, subagent-manager falls back
  // - launchProfile: unknown values default to normal launch behavior

  return { valid: errors.length === 0, errors };
}

interface ParseSubagentContentOptions {
  inheritedConfigs?: Record<string, SubagentConfig>;
  modelSource?: SubagentRecommendedModelSource;
}

function hasFrontmatterField(
  frontmatter: Record<string, string | string[]>,
  field: string,
): boolean {
  return Object.hasOwn(frontmatter, field);
}

function cloneAllowedTools(allowedTools: string[] | "all"): string[] | "all" {
  return allowedTools === "all" ? "all" : [...allowedTools];
}

function applySubagentOverlay(
  inherited: SubagentConfig,
  frontmatter: Record<string, string | string[]>,
  modelSource: SubagentRecommendedModelSource | undefined,
): SubagentConfig {
  const hasModel = hasFrontmatterField(frontmatter, "model");

  return {
    ...inherited,
    name: frontmatter.name as string,
    description: hasFrontmatterField(frontmatter, "description")
      ? getStringField(frontmatter, "description") || inherited.description
      : inherited.description,
    systemPrompt: inherited.systemPrompt,
    allowedTools: hasFrontmatterField(frontmatter, "tools")
      ? parseTools(getStringField(frontmatter, "tools"))
      : cloneAllowedTools(inherited.allowedTools),
    recommendedModel: hasModel
      ? getStringField(frontmatter, "model") || "inherit"
      : inherited.recommendedModel,
    recommendedModelSource: hasModel
      ? modelSource
      : inherited.recommendedModelSource,
    skills: hasFrontmatterField(frontmatter, "skills")
      ? parseSkills(getStringField(frontmatter, "skills"))
      : [...inherited.skills],
    fork: hasFrontmatterField(frontmatter, "fork")
      ? getStringField(frontmatter, "fork")?.toLowerCase() === "true"
      : inherited.fork,
    background: hasFrontmatterField(frontmatter, "background")
      ? parseBackgroundDefault(getStringField(frontmatter, "background"))
      : inherited.background,
    launchProfile: hasFrontmatterField(frontmatter, "launchProfile")
      ? parseLaunchProfile(getStringField(frontmatter, "launchProfile"))
      : inherited.launchProfile,
  };
}

/**
 * Parse a subagent from markdown content
 */
function parseSubagentContent(
  content: string,
  options: ParseSubagentContentOptions = {},
): SubagentConfig {
  const { frontmatter, body } = parseFrontmatter(content);

  const nameValidation = validateFrontmatter(frontmatter, {
    requireDescription: false,
  });
  if (!nameValidation.valid) {
    throw new Error(nameValidation.errors.join("; "));
  }

  const name = frontmatter.name as string;
  const isBodyless = body.trim().length === 0;

  if (isBodyless) {
    const inherited = options.inheritedConfigs?.[name];
    if (!inherited) {
      throw new Error(
        `Bodyless subagent overlay "${name}" requires an existing lower-precedence config`,
      );
    }

    return applySubagentOverlay(inherited, frontmatter, options.modelSource);
  }

  // Validate frontmatter for full-replacement custom subagents.
  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const description = frontmatter.description as string;
  const hasModel = hasFrontmatterField(frontmatter, "model");

  return {
    name,
    description,
    systemPrompt: body,
    allowedTools: parseTools(getStringField(frontmatter, "tools")),
    recommendedModel: getStringField(frontmatter, "model") || "inherit",
    recommendedModelSource: hasModel ? options.modelSource : undefined,
    skills: parseSkills(getStringField(frontmatter, "skills")),
    fork: getStringField(frontmatter, "fork")?.toLowerCase() === "true",
    background: parseBackgroundDefault(
      getStringField(frontmatter, "background"),
    ),
    launchProfile: parseLaunchProfile(
      getStringField(frontmatter, "launchProfile"),
    ),
  };
}

/**
 * Parse a subagent file
 */
async function parseSubagentFile(
  filePath: string,
  inheritedConfigs: Record<string, SubagentConfig>,
): Promise<SubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  return parseSubagentContent(content, {
    inheritedConfigs,
    modelSource: "user",
  });
}

/**
 * Built-in subagents that ship with the package
 * These are available to all users without configuration
 */
function usesLocalMemfsBuiltinPrompts(): boolean {
  return getBackend().capabilities.localMemfs;
}

function getBuiltinSubagents(
  localMemfs = usesLocalMemfsBuiltinPrompts(),
): Record<string, SubagentConfig> {
  const cacheKey = localMemfs ? "localMemfs" : "standard";
  if (cache.builtins[cacheKey]) {
    return cache.builtins[cacheKey];
  }

  const builtins: Record<string, SubagentConfig> = {};
  const sources = localMemfs
    ? LOCAL_MEMFS_BUILTIN_SOURCES
    : STANDARD_BUILTIN_SOURCES;

  for (const source of sources) {
    try {
      const config = parseSubagentContent(source, {
        modelSource: "builtin",
      });
      builtins[config.name] = config;
    } catch (error) {
      // Built-in subagents should always be valid; log error but don't crash
      console.warn(
        `[subagent] Failed to parse built-in subagent: ${getErrorMessage(error)}`,
      );
    }
  }

  cache.builtins[cacheKey] = builtins;
  return builtins;
}

/**
 * Get the names of built-in subagents
 */
export function getBuiltinSubagentNames(): Set<string> {
  return new Set(Object.keys(getBuiltinSubagents()));
}

/**
 * Discover subagents from a single directory
 */
async function discoverSubagentsFromDir(
  agentsDir: string,
  configsByName: Record<string, SubagentConfig>,
  subagents: SubagentConfig[],
  errors: Array<{ path: string; message: string }>,
): Promise<void> {
  if (!existsSync(agentsDir)) {
    return;
  }

  try {
    const entries = await readdir(agentsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      const filePath = join(agentsDir, entry.name);

      try {
        const config = await parseSubagentFile(filePath, configsByName);
        if (config) {
          // Check for duplicate names (later directories override earlier ones)
          const existingIndex = subagents.findIndex(
            (s) => s.name === config.name,
          );
          if (existingIndex !== -1) {
            subagents.splice(existingIndex, 1);
          }

          configsByName[config.name] = config;
          subagents.push(config);
        }
      } catch (error) {
        errors.push({
          path: filePath,
          message: getErrorMessage(error),
        });
      }
    }
  } catch (error) {
    errors.push({
      path: agentsDir,
      message: `Failed to read agents directory: ${getErrorMessage(error)}`,
    });
  }
}

/**
 * Discover subagents from global (~/.letta/agents) and project (.letta/agents) directories
 * Project-level subagents override global ones with the same name
 */
export async function discoverSubagents(
  workingDirectory: string = process.cwd(),
  inheritedConfigs: Record<string, SubagentConfig> = {
    ...getBuiltinSubagents(),
  },
): Promise<SubagentDiscoveryResult> {
  const errors: Array<{ path: string; message: string }> = [];
  const subagents: SubagentConfig[] = [];

  // First, discover from global directory (~/.letta/agents)
  await discoverSubagentsFromDir(
    getGlobalAgentsDir(),
    inheritedConfigs,
    subagents,
    errors,
  );

  // Then, discover from project directory (.letta/agents)
  // Project-level overrides global with same name
  const projectAgentsDir = join(workingDirectory, AGENTS_DIR);
  await discoverSubagentsFromDir(
    projectAgentsDir,
    inheritedConfigs,
    subagents,
    errors,
  );

  return { subagents, errors };
}

/**
 * Get all subagent configurations
 * Includes built-in subagents and any user-defined ones from .letta/agents/
 * User-defined subagents override built-ins with the same name
 * Results are cached per working directory
 */
export async function getAllSubagentConfigs(
  workingDirectory: string = process.cwd(),
): Promise<Record<string, SubagentConfig>> {
  const localMemfs = usesLocalMemfsBuiltinPrompts();
  // Return cached if same working directory
  if (
    cache.configs &&
    cache.workingDir === workingDirectory &&
    cache.localMemfs === localMemfs
  ) {
    return cache.configs;
  }

  // Start with a copy of built-in subagents (don't mutate the cache)
  const configs: Record<string, SubagentConfig> = {
    ...getBuiltinSubagents(localMemfs),
  };

  // Discover user-defined subagents from .letta/agents/
  const { subagents, errors } = await discoverSubagents(
    workingDirectory,
    configs,
  );

  // Log any discovery errors
  for (const error of errors) {
    console.warn(`[subagent] Warning: ${error.path}: ${error.message}`);
  }

  // User-defined subagents override built-ins with the same name
  for (const subagent of subagents) {
    configs[subagent.name] = subagent;
  }

  // Cache results
  cache.configs = configs;
  cache.workingDir = workingDirectory;
  cache.localMemfs = localMemfs;

  return configs;
}

/**
 * Clear the subagent config cache (useful when files change)
 */
export function clearSubagentConfigCache(): void {
  cache.configs = null;
  cache.workingDir = null;
  cache.localMemfs = null;
}
