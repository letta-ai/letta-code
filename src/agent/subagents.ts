/**
 * Subagent configuration, discovery, and management
 *
 * All subagents are defined as Markdown files with YAML frontmatter
 * in the .letta/agents/ directory.
 */

import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { getErrorMessage } from "../utils/error";
import {
  getStringField,
  parseCommaSeparatedList,
  parseFrontmatter,
} from "../utils/frontmatter";
import { MEMORY_BLOCK_LABELS, type MemoryBlockLabel } from "./memory";

// Re-export for convenience
export type { MemoryBlockLabel };

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
}

/**
 * Result of subagent discovery
 */
export interface SubagentDiscoveryResult {
  subagents: SubagentConfig[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Directory for subagent files
 */
export const AGENTS_DIR = ".letta/agents";

/**
 * Valid memory block labels (derived from memory.ts)
 */
const VALID_MEMORY_BLOCKS: Set<string> = new Set(MEMORY_BLOCK_LABELS);

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
 * Parse a subagent file
 */
async function parseSubagentFile(
  filePath: string,
): Promise<SubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Validate frontmatter
  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  // Extract fields using helper
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
  };
}

/**
 * Discover subagents from .letta/agents/ directory
 */
export async function discoverSubagents(
  workingDirectory: string = process.cwd(),
): Promise<SubagentDiscoveryResult> {
  const agentsDir = join(workingDirectory, AGENTS_DIR);
  const errors: Array<{ path: string; message: string }> = [];
  const subagents: SubagentConfig[] = [];
  const seenNames = new Set<string>();

  // Check if directory exists
  if (!existsSync(agentsDir)) {
    return { subagents: [], errors: [] };
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
          // Check for duplicate names
          if (seenNames.has(config.name)) {
            errors.push({
              path: filePath,
              message: `Duplicate subagent name "${config.name}" - skipping`,
            });
            continue;
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

  return { subagents, errors };
}

/**
 * Cache for configs to avoid repeated discovery
 */
let cachedConfigs: Record<string, SubagentConfig> | null = null;
let cacheWorkingDir: string | null = null;

/**
 * Get all subagent configurations from .letta/agents/
 * Results are cached per working directory
 */
export async function getAllSubagentConfigs(
  workingDirectory: string = process.cwd(),
): Promise<Record<string, SubagentConfig>> {
  // Return cached if same working directory
  if (cachedConfigs && cacheWorkingDir === workingDirectory) {
    return cachedConfigs;
  }

  const configs: Record<string, SubagentConfig> = {};

  // Discover all subagents from .letta/agents/
  const { subagents, errors } = await discoverSubagents(workingDirectory);

  // Log any discovery errors
  for (const error of errors) {
    console.warn(`[subagent] Warning: ${error.path}: ${error.message}`);
  }

  // Convert to map by name
  for (const subagent of subagents) {
    configs[subagent.name] = subagent;
  }

  // Cache results
  cachedConfigs = configs;
  cacheWorkingDir = workingDirectory;

  return configs;
}

/**
 * Clear the subagent config cache (useful when files change)
 */
export function clearSubagentConfigCache(): void {
  cachedConfigs = null;
  cacheWorkingDir = null;
}
