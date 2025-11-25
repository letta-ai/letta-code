/**
 * Subagent configuration, discovery, and management
 *
 * All subagents are defined as Markdown files with YAML frontmatter
 * in the .letta/agents/ directory.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, generateFrontmatter } from "../utils/frontmatter";
import { MEMORY_BLOCK_LABELS, type MemoryBlockLabel } from "./memory";

// Re-export for convenience
export type { MemoryBlockLabel };

/** Subagent type is just a string (the name from the .md file) */
export type SubagentType = string;

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
  /** Permission mode for the subagent (unknown values default to "default") */
  permissionMode: string;
  /** Skills to auto-load */
  skills: string[];
  /** Memory blocks the subagent has access to - list of labels or "all" or "none" */
  memoryBlocks: MemoryBlockLabel[] | "all" | "none";
  /** Path to the source file */
  filePath: string;
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
  if (!toolsStr || toolsStr.trim() === "" || toolsStr.trim().toLowerCase() === "all") {
    return "all";
  }

  const tools = toolsStr
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return tools.length > 0 ? tools : "all";
}

/**
 * Parse comma-separated skills string
 */
function parseSkills(skillsStr: string | undefined): string[] {
  if (!skillsStr || skillsStr.trim() === "") {
    return [];
  }

  return skillsStr
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse comma-separated memory blocks string into validated block labels
 */
function parseMemoryBlocks(
  blocksStr: string | undefined,
): MemoryBlockLabel[] | "all" | "none" {
  if (!blocksStr || blocksStr.trim() === "" || blocksStr.trim().toLowerCase() === "all") {
    return "all";
  }

  if (blocksStr.trim().toLowerCase() === "none") {
    return "none";
  }

  const blocks: MemoryBlockLabel[] = [];
  const parts = blocksStr.split(",").map((b) => b.trim().toLowerCase());

  for (const part of parts) {
    if (VALID_MEMORY_BLOCKS.has(part)) {
      blocks.push(part as MemoryBlockLabel);
    }
  }

  return blocks.length > 0 ? blocks : "all";
}

/**
 * Validate subagent frontmatter
 * Only validates required fields - optional fields are validated at runtime where needed
 */
function validateFrontmatter(
  frontmatter: Record<string, string | string[]>,
): { valid: boolean; errors: string[] } {
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
async function parseSubagentFile(filePath: string): Promise<SubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Validate frontmatter
  const validation = validateFrontmatter(frontmatter);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const name = frontmatter.name as string;
  const description = frontmatter.description as string;
  const toolsStr =
    typeof frontmatter.tools === "string" ? frontmatter.tools : undefined;
  const modelStr =
    typeof frontmatter.model === "string" ? frontmatter.model : undefined;
  const permissionModeStr =
    typeof frontmatter.permissionMode === "string"
      ? frontmatter.permissionMode
      : undefined;
  const skillsStr =
    typeof frontmatter.skills === "string" ? frontmatter.skills : undefined;
  const memoryBlocksStr =
    typeof frontmatter.memoryBlocks === "string"
      ? frontmatter.memoryBlocks
      : undefined;

  return {
    name,
    description,
    systemPrompt: body,
    allowedTools: parseTools(toolsStr),
    recommendedModel: modelStr || "inherit",
    permissionMode: (permissionModeStr as PermissionMode) || "default",
    skills: parseSkills(skillsStr),
    memoryBlocks: parseMemoryBlocks(memoryBlocksStr),
    filePath,
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
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    errors.push({
      path: agentsDir,
      message: `Failed to read agents directory: ${error instanceof Error ? error.message : String(error)}`,
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

/**
 * Get list of all available subagent types
 */
export async function getAvailableSubagentTypes(
  workingDirectory?: string,
): Promise<string[]> {
  const configs = await getAllSubagentConfigs(workingDirectory);
  return Object.keys(configs);
}

/**
 * Default system prompt template for new subagents
 */
const DEFAULT_SYSTEM_PROMPT_TEMPLATE = `You are a specialized agent.

Your task: {user_provided_prompt}

You are a specialized subagent launched via the Task tool. You run autonomously and return a single final report when done.
You CANNOT ask questions mid-execution - all instructions are provided upfront.
You DO have access to the full conversation history, so you can reference earlier context.

## Instructions

[Add your specific instructions here]

## Output Format

[Describe the expected output format]
`;

/**
 * Create a new subagent file
 */
export async function createSubagentFile(
  name: string,
  description: string,
  options: {
    tools?: string;
    model?: string;
    permissionMode?: string;
    skills?: string;
    memoryBlocks?: string;
    systemPrompt?: string;
  } = {},
  workingDirectory: string = process.cwd(),
): Promise<string> {
  // Validate name
  if (!isValidName(name)) {
    throw new Error(
      `Invalid name "${name}": must start with lowercase letter and contain only lowercase letters, numbers, and hyphens`,
    );
  }

  const agentsDir = join(workingDirectory, AGENTS_DIR);

  // Ensure directory exists
  if (!existsSync(agentsDir)) {
    await mkdir(agentsDir, { recursive: true });
  }

  const filePath = join(agentsDir, `${name}.md`);

  // Check if file already exists
  if (existsSync(filePath)) {
    throw new Error(`Subagent "${name}" already exists at ${filePath}`);
  }

  // Generate frontmatter
  const frontmatterData: Record<string, string | undefined> = {
    name,
    description,
    tools: options.tools,
    model: options.model,
    permissionMode: options.permissionMode,
    skills: options.skills,
  };

  const frontmatter = generateFrontmatter(frontmatterData);
  const systemPrompt = options.systemPrompt || DEFAULT_SYSTEM_PROMPT_TEMPLATE;
  const content = `${frontmatter}\n\n${systemPrompt}`;

  await writeFile(filePath, content, "utf-8");

  return filePath;
}

/**
 * Delete a subagent file
 */
export async function deleteSubagentFile(
  name: string,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const agentsDir = join(workingDirectory, AGENTS_DIR);
  const filePath = join(agentsDir, `${name}.md`);

  if (!existsSync(filePath)) {
    throw new Error(`Subagent "${name}" not found at ${filePath}`);
  }

  await unlink(filePath);
}

/**
 * Get the path to a subagent file
 */
export function getSubagentPath(
  name: string,
  workingDirectory: string = process.cwd(),
): string {
  return join(workingDirectory, AGENTS_DIR, `${name}.md`);
}
