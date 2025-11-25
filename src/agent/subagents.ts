/**
 * Subagent configuration and system prompts
 *
 * This module defines different subagent types that can be spawned via the Task tool.
 * Each subagent type has:
 * - A specialized system prompt
 * - A whitelist of allowed tools
 * - A recommended model
 * - A description of when to use it
 *
 * Custom subagents can be defined in .letta/agents/ as Markdown files.
 */

import type { ToolName } from "../tools/toolDefinitions";
import {
  discoverCustomSubagents,
  type CustomSubagentConfig,
  type PermissionMode,
} from "./custom-subagents";

/** Built-in subagent types */
export type BuiltinSubagentType = "Explore" | "Plan" | "general-purpose";

/** All subagent types (built-in or custom) */
export type SubagentType = string;

export interface SubagentConfig {
  /** System prompt for this subagent type */
  systemPrompt: string;
  /** Tools this subagent type can access - list of tools or "all" */
  allowedTools: ToolName[] | "all";
  /** Recommended model for this subagent type */
  recommendedModel: string;
  /** Description of when to use this subagent type */
  description: string;
  /** Permission mode for the subagent (custom subagents only) */
  permissionMode?: PermissionMode;
  /** Skills to auto-load (custom subagents only) */
  skills?: string[];
  /** Whether this is a built-in subagent */
  isBuiltin?: boolean;
  /** Path to the source file (custom subagents only) */
  filePath?: string;
}

/**
 * System prompt for Explore subagent
 * Fast, efficient codebase exploration agent
 */
const EXPLORE_SYSTEM_PROMPT = `You are a fast, efficient codebase exploration agent.

Your task: {user_provided_prompt}

You are a specialized subagent launched via the Task tool. You run autonomously and return a single final report when done.
You CANNOT ask questions mid-execution - all instructions are provided upfront.
You DO have access to the full conversation history, so you can reference "the error mentioned earlier" or "the file discussed above".

Instructions:
- Use Glob to find files by patterns (e.g., "**/*.ts", "src/components/**/*.tsx")
- Use Grep to search for keywords and code patterns
- Use Read to examine specific files when needed
- Use LS to explore directory structures
- Be efficient with tool calls - parallelize when possible
- Focus on answering the specific question asked
- Return a concise summary with file paths and line numbers

Output format:
1. Direct answer to the question
2. List of relevant files with paths
3. Key findings with code references (file:line)

Remember: You're exploring, not modifying. You have read-only access.`;

/**
 * System prompt for Plan subagent
 * Planning agent that breaks down complex tasks
 */
const PLAN_SYSTEM_PROMPT = `You are a planning agent that breaks down complex tasks into actionable steps.

Your task: {user_provided_prompt}

You are a specialized subagent launched via the Task tool. You run autonomously and return a single final report when done.
You CANNOT ask questions mid-execution - all instructions are provided upfront.
You DO have access to the full conversation history, so you can reference previous discussions.

Instructions:
- Use Glob and Grep to understand the codebase structure
- Use Read to examine relevant files and understand patterns
- Use LS to explore project organization
- Break down the task into clear, sequential steps
- Identify dependencies between steps
- Note which files will need to be modified
- Consider edge cases and testing requirements

Output format:
1. High-level approach (2-3 sentences)
2. Numbered list of steps with:
   - What to do
   - Which files to modify
   - Key considerations
3. Potential challenges and how to address them

Remember: You're planning, not implementing. Don't make changes, just create a roadmap.`;

/**
 * System prompt for general-purpose subagent
 * Full-capability agent for research and implementation
 */
const GENERAL_PURPOSE_SYSTEM_PROMPT = `You are a general-purpose coding agent that can research, plan, and implement.

Your task: {user_provided_prompt}

You are a specialized subagent launched via the Task tool. You run autonomously and return a single final report when done.
You CANNOT ask questions mid-execution - all instructions are provided upfront, so:
- Make reasonable assumptions based on context
- Use the conversation history to understand requirements
- Document any assumptions you make

You DO have access to the full conversation history before you were launched.

Instructions:
- You have access to all tools (Read, Write, Edit, Grep, Glob, Bash, TodoWrite, etc.)
- Break down complex tasks into steps
- Search the codebase to understand existing patterns
- Follow existing code conventions and style
- Test your changes if possible
- Be thorough but efficient

Output format:
1. Summary of what you did
2. Files modified with changes made
3. Any assumptions or decisions you made
4. Suggested next steps (if any)

Remember: You are stateless and return ONE final report when done. Make changes confidently based on the context provided.`;

/**
 * Configuration for built-in subagent types
 */
export const BUILTIN_SUBAGENT_CONFIGS: Record<BuiltinSubagentType, SubagentConfig> = {
  Explore: {
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    allowedTools: ["Glob", "Grep", "Read", "LS", "BashOutput"],
    recommendedModel: "haiku", // Use model ID, will be resolved via model.ts
    description:
      "Fast agent for codebase exploration - finding files, searching code, understanding structure",
    isBuiltin: true,
  },
  Plan: {
    systemPrompt: PLAN_SYSTEM_PROMPT,
    allowedTools: ["Glob", "Grep", "Read", "LS", "BashOutput"],
    recommendedModel: "opus", // Use model ID, will be resolved via model.ts
    description:
      "Planning agent that breaks down complex tasks into actionable steps",
    isBuiltin: true,
  },
  "general-purpose": {
    systemPrompt: GENERAL_PURPOSE_SYSTEM_PROMPT,
    allowedTools: [
      "Bash",
      "BashOutput",
      "Edit",
      "Glob",
      "Grep",
      "KillBash",
      "LS",
      "MultiEdit",
      "Read",
      "TodoWrite",
      "Write",
    ],
    recommendedModel: "sonnet-4.5", // Use model ID, will be resolved via model.ts
    description:
      "Full-capability agent for research, planning, and implementation",
    isBuiltin: true,
  },
};

/** @deprecated Use BUILTIN_SUBAGENT_CONFIGS instead */
export const SUBAGENT_CONFIGS = BUILTIN_SUBAGENT_CONFIGS;

/**
 * Convert a CustomSubagentConfig to a SubagentConfig
 */
function customToSubagentConfig(custom: CustomSubagentConfig): SubagentConfig {
  return {
    systemPrompt: custom.systemPrompt,
    allowedTools: custom.allowedTools,
    recommendedModel: custom.recommendedModel,
    description: custom.description,
    permissionMode: custom.permissionMode,
    skills: custom.skills,
    isBuiltin: false,
    filePath: custom.filePath,
  };
}

/**
 * Cache for merged configs to avoid repeated discovery
 */
let cachedConfigs: Record<string, SubagentConfig> | null = null;
let cacheWorkingDir: string | null = null;

/**
 * Get all subagent configurations (built-in + custom)
 * Results are cached per working directory
 */
export async function getAllSubagentConfigs(
  workingDirectory: string = process.cwd(),
): Promise<Record<string, SubagentConfig>> {
  // Return cached if same working directory
  if (cachedConfigs && cacheWorkingDir === workingDirectory) {
    return cachedConfigs;
  }

  // Start with built-in configs
  const configs: Record<string, SubagentConfig> = {
    ...BUILTIN_SUBAGENT_CONFIGS,
  };

  // Discover and add custom subagents
  const { subagents, errors } = await discoverCustomSubagents(workingDirectory);

  // Log any discovery errors
  for (const error of errors) {
    console.warn(`[subagent] Warning: ${error.path}: ${error.message}`);
  }

  // Add custom subagents (they override built-ins if names conflict, but that shouldn't happen)
  for (const custom of subagents) {
    if (custom.name in configs) {
      console.warn(
        `[subagent] Warning: Custom subagent "${custom.name}" conflicts with built-in, skipping`,
      );
      continue;
    }
    configs[custom.name] = customToSubagentConfig(custom);
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
 * Get subagent configuration for a given type (built-in only, synchronous)
 * @deprecated Use getAllSubagentConfigs for custom subagent support
 */
export function getSubagentConfig(type: BuiltinSubagentType): SubagentConfig {
  const config = BUILTIN_SUBAGENT_CONFIGS[type];
  if (!config) {
    throw new Error(`Unknown built-in subagent type: ${type}`);
  }
  return config;
}

/**
 * Check if a subagent type is a built-in type
 */
export function isBuiltinSubagentType(type: string): type is BuiltinSubagentType {
  return type in BUILTIN_SUBAGENT_CONFIGS;
}

/**
 * Check if a subagent type is valid (checks cache, may need getAllSubagentConfigs first)
 * @deprecated Use getAllSubagentConfigs and check directly
 */
export function isValidSubagentType(type: string): boolean {
  // Check built-in first
  if (type in BUILTIN_SUBAGENT_CONFIGS) {
    return true;
  }
  // Check cache if available
  if (cachedConfigs) {
    return type in cachedConfigs;
  }
  // Can't check custom subagents synchronously
  return false;
}

/**
 * Get list of built-in subagent types
 */
export function getBuiltinSubagentTypes(): BuiltinSubagentType[] {
  return Object.keys(BUILTIN_SUBAGENT_CONFIGS) as BuiltinSubagentType[];
}

/**
 * Get list of all available subagent types (requires async discovery)
 */
export async function getAvailableSubagentTypes(
  workingDirectory?: string,
): Promise<string[]> {
  const configs = await getAllSubagentConfigs(workingDirectory);
  return Object.keys(configs);
}
