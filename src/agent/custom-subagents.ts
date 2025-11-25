/**
 * Custom subagent configuration file parsing and management
 *
 * Custom subagents are defined as Markdown files with YAML frontmatter
 * in the .letta/agents/ directory.
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter, generateFrontmatter } from "../utils/frontmatter";
import type { ToolName } from "../tools/toolDefinitions";
import { MEMORY_BLOCK_LABELS, type MemoryBlockLabel } from "./memory";

/**
 * Permission modes for custom subagents
 */
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan";

/**
 * Frontmatter fields for custom subagent files
 */
export interface CustomSubagentFrontmatter {
  name: string;
  description: string;
  tools?: string;
  model?: string;
  permissionMode?: string;
  skills?: string;
  memoryBlocks?: string;
}

// Re-export MemoryBlockLabel for convenience
export type { MemoryBlockLabel };

/**
 * Parsed and validated custom subagent configuration
 */
export interface CustomSubagentConfig {
  /** Unique identifier for the subagent */
  name: string;
  /** Description of when to use this subagent */
  description: string;
  /** System prompt for the subagent */
  systemPrompt: string;
  /** Allowed tools - specific list or "all" */
  allowedTools: ToolName[] | "all";
  /** Recommended model (sonnet/opus/haiku/inherit) */
  recommendedModel: string;
  /** Permission mode for the subagent */
  permissionMode: PermissionMode;
  /** Skills to auto-load */
  skills: string[];
  /** Memory blocks the subagent has access to - list of labels or "all" or "none" */
  memoryBlocks: MemoryBlockLabel[] | "all" | "none";
  /** Path to the source file */
  filePath: string;
}

/**
 * Result of custom subagent discovery
 */
export interface CustomSubagentDiscoveryResult {
  subagents: CustomSubagentConfig[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * Directory for custom subagent files
 */
export const CUSTOM_AGENTS_DIR = ".letta/agents";

/**
 * Valid tool names for validation
 */
const VALID_TOOLS: Set<string> = new Set([
  "Bash",
  "BashOutput",
  "Edit",
  "ExitPlanMode",
  "Glob",
  "Grep",
  "KillBash",
  "LS",
  "MultiEdit",
  "Read",
  "Task",
  "TodoWrite",
  "Write",
]);

/**
 * Valid model values
 */
const VALID_MODELS = new Set(["sonnet", "opus", "haiku", "inherit", ""]);

/**
 * Valid permission modes
 */
const VALID_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

/**
 * Valid memory block labels (derived from memory.ts)
 */
const VALID_MEMORY_BLOCKS: Set<string> = new Set(MEMORY_BLOCK_LABELS);

/**
 * Validate a custom subagent name
 */
function isValidName(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

/**
 * Parse comma-separated tools string into validated tool names
 */
function parseTools(toolsStr: string | undefined): ToolName[] | "all" {
  if (!toolsStr || toolsStr.trim() === "" || toolsStr.trim().toLowerCase() === "all") {
    return "all";
  }

  const tools: ToolName[] = [];
  const parts = toolsStr.split(",").map((t) => t.trim());

  for (const part of parts) {
    if (VALID_TOOLS.has(part)) {
      tools.push(part as ToolName);
    }
  }

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
 * Validate custom subagent frontmatter
 */
function validateFrontmatter(
  frontmatter: Record<string, string | string[]>,
  filePath: string,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Check required fields
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

  // Validate optional fields
  const model = frontmatter.model;
  if (model && typeof model === "string" && !VALID_MODELS.has(model)) {
    errors.push(
      `Invalid model "${model}": must be one of sonnet, opus, haiku, inherit`,
    );
  }

  const permissionMode = frontmatter.permissionMode;
  if (
    permissionMode &&
    typeof permissionMode === "string" &&
    !VALID_PERMISSION_MODES.has(permissionMode)
  ) {
    errors.push(
      `Invalid permissionMode "${permissionMode}": must be one of default, acceptEdits, bypassPermissions, plan`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Parse a custom subagent file
 */
async function parseCustomSubagentFile(
  filePath: string,
): Promise<CustomSubagentConfig | null> {
  const content = await readFile(filePath, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  // Validate frontmatter
  const validation = validateFrontmatter(frontmatter, filePath);
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
 * Discover custom subagents from .letta/agents/ directory
 */
export async function discoverCustomSubagents(
  workingDirectory: string = process.cwd(),
): Promise<CustomSubagentDiscoveryResult> {
  const agentsDir = join(workingDirectory, CUSTOM_AGENTS_DIR);
  const errors: Array<{ path: string; message: string }> = [];
  const subagents: CustomSubagentConfig[] = [];
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
        const config = await parseCustomSubagentFile(filePath);
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
 * Default system prompt template for new custom subagents
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
 * Create a new custom subagent file
 */
export async function createCustomSubagentFile(
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

  const agentsDir = join(workingDirectory, CUSTOM_AGENTS_DIR);

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
 * Delete a custom subagent file
 */
export async function deleteCustomSubagentFile(
  name: string,
  workingDirectory: string = process.cwd(),
): Promise<void> {
  const agentsDir = join(workingDirectory, CUSTOM_AGENTS_DIR);
  const filePath = join(agentsDir, `${name}.md`);

  if (!existsSync(filePath)) {
    throw new Error(`Subagent "${name}" not found at ${filePath}`);
  }

  await unlink(filePath);
}

/**
 * Get the path to a custom subagent file
 */
export function getCustomSubagentPath(
  name: string,
  workingDirectory: string = process.cwd(),
): string {
  return join(workingDirectory, CUSTOM_AGENTS_DIR, `${name}.md`);
}
