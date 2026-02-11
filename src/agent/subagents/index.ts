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
import { getErrorMessage } from "../../utils/error";
import {
  getStringField,
  parseCommaSeparatedList,
  parseFrontmatter,
} from "../../utils/frontmatter";
import { MEMORY_BLOCK_LABELS, type MemoryBlockLabel } from "../memory";

// Built-in subagent definitions (embedded at build time)
import exploreAgentMd from "./builtin/explore.md";
import generalPurposeAgentMd from "./builtin/general-purpose.md";
import memoryAgentMd from "./builtin/memory.md";
import planAgentMd from "./builtin/plan.md";
import recallAgentMd from "./builtin/recall.md";
import reflectionAgentMd from "./builtin/reflection.md";

const BUILTIN_SOURCES = [
  exploreAgentMd,
  generalPurposeAgentMd,
  memoryAgentMd,
  planAgentMd,
  recallAgentMd,
  reflectionAgentMd,
];

// Re-export for convenience
export type { MemoryBlockLabel };

// ============================================================================
// Types
// ============================================================================

/**
 * Subagent configuration
 */
export interface SubagentConfig {
  /** Unique identifier for the subagent */
  name: string;
  /** Description of when to use this subagent */
  description: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /** Allowed tools - specific list or "all" (invalid names are ignored at runtime) */
  allowedTools: string[] | "all";
  /** Recommended model - any model ID from models.json or full handle */
  recommendedModel: string;
  /** Skills to auto-load */
  skills: string[];
  /** Memory blocks the subagent has access to - list of labels or "all" or "none" */
  memoryBlocks: MemoryBlockLabel[] | "all" | "none";
  /** Permission mode for this subagent (default, acceptEdits, plan, bypassPermissions) */
  permissionMode?: string;
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
export const GLOBAL_AGENTS_DIR = join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".letta/agents",
);

/**
 * Valid memory block labels (derived from memory.ts)
 */
const VALID_MEMORY_BLOCKS: Set<string> = new Set(MEMORY_BLOCK_LABELS);

// ============================================================================
// Cache
// ============================================================================

/**
 * Consolidated cache for subagent configurations
 * - builtins: parsed once from bundled markdown, never changes
 * - configs: builtins + custom agents, invalidated when workingDir changes
 */
const cache = {
  builtins: null as Record<string, SubagentConfig> | null,
  configs: null as Record<string, SubagentConfig> | null,
  workingDir: null as string | null,
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

/**
 * Parse comma-separated memory blocks string into validated block labels
 */
function parseMemoryBlocks(
  blocksStr: string | undefined,
): MemoryBlockLabel[] | "all" | "none" {
  if (
    !blocksStr ||
    blocksStr.trim() === "" ||
    blocksStr.trim().toLowerCase() === "all"
  ) {
    return "all";
  }

  if (blocksStr.trim().toLowerCase() === "none") {
    return "none";
  }

  const parts = parseCommaSeparatedList(blocksStr).map((b) => b.toLowerCase());
  const blocks = parts.filter((p) =>
    VALID_MEMORY_BLOCKS.has(p),
  ) as MemoryBlockLabel[];

  return blocks.length > 0 ? blocks : "all";
}

/**
 * Validate subagent frontmatter
 * Only validates required fields - optional fields are validated at runtime where needed
 */
function validateFrontmatter(frontmatter: Record<string, string | string[]>): {
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
  if (!description || typeof description !== "string") {
    errors.push("Missing required field: description");
  }

  // Don't validate model or permissionMode here - they're handled at runtime:
  // - model: resolveModel() returns null for invalid values, subagent-manager falls back
  // - permissionMode: unknown values default to "default" behavior

  return { valid: errors.length === 0, errors };
}

/**
 * Parse a subagent from markdown content
 */
function parseSubagentContent(content: string): SubagentConfig {
  const { frontmatter, body } = parseFrontmatter(content);

  // Validate frontmatter
  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const name = frontmatter.name as string;
  const description = frontmatter.description as string;

  return {
    name,
    description,
    systemPrompt: body,
    allowedTools: parseTools(getStringField(frontmatter, "tools")),
    recommendedModel: getStringField(frontmatter, "model") || "inherit",
    skills: parseSkills(getStringField(frontmatter, "skills")),
    memoryBlocks: parseMemoryBlocks(
      getStringField(frontmatter, "memoryBlocks"),
    ),
    permissionMode: getStringField(frontmatter, "permissionMode"),
  };
}

/**
 * Parse a subagent file
 */
async function parseSubagentFile(
  filePath: string,
): Promise<SubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  return parseSubagentContent(content);
}

/**
 * Built-in subagents that ship with the package
 * These are available to all users without configuration
 */
function getBuiltinSubagents(): Record<string, SubagentConfig> {
  if (cache.builtins) {
    return cache.builtins;
  }

  const builtins: Record<string, SubagentConfig> = {};

  for (const source of BUILTIN_SOURCES) {
    try {
      const config = parseSubagentContent(source);
      builtins[config.name] = config;
    } catch (error) {
      // Built-in subagents should always be valid; log error but don't crash
      console.warn(
        `[subagent] Failed to parse built-in subagent: ${getErrorMessage(error)}`,
      );
    }
  }

  cache.builtins = builtins;
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
  seenNames: Set<string>,
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
        const config = await parseSubagentFile(filePath);
        if (config) {
          // Check for duplicate names (later directories override earlier ones)
          if (seenNames.has(config.name)) {
            // Remove the existing one and replace with this one
            const existingIndex = subagents.findIndex(
              (s) => s.name === config.name,
            );
            if (existingIndex !== -1) {
              subagents.splice(existingIndex, 1);
            }
          }

          seenNames.add(config.name);
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
): Promise<SubagentDiscoveryResult> {
  const errors: Array<{ path: string; message: string }> = [];
  const subagents: SubagentConfig[] = [];
  const seenNames = new Set<string>();

  // First, discover from global directory (~/.letta/agents)
  await discoverSubagentsFromDir(
    GLOBAL_AGENTS_DIR,
    seenNames,
    subagents,
    errors,
  );

  // Then, discover from project directory (.letta/agents)
  // Project-level overrides global with same name
  const projectAgentsDir = join(workingDirectory, AGENTS_DIR);
  await discoverSubagentsFromDir(
    projectAgentsDir,
    seenNames,
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
  // Return cached if same working directory
  if (cache.configs && cache.workingDir === workingDirectory) {
    return cache.configs;
  }

  // Start with a copy of built-in subagents (don't mutate the cache)
  const configs: Record<string, SubagentConfig> = { ...getBuiltinSubagents() };

  // Discover user-defined subagents from .letta/agents/
  const { subagents, errors } = await discoverSubagents(workingDirectory);

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

  return configs;
}

/**
 * Clear the subagent config cache (useful when files change)
 */
export function clearSubagentConfigCache(): void {
  cache.configs = null;
  cache.workingDir = null;
}
