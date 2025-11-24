/**
 * Subagent configuration and system prompts
 *
 * This module defines different subagent types that can be spawned via the Task tool.
 * Each subagent type has:
 * - A specialized system prompt
 * - A whitelist of allowed tools
 * - A recommended model
 * - A description of when to use it
 */

import type { ToolName } from "../tools/toolDefinitions";

export type SubagentType = "Explore" | "Plan" | "general-purpose";

export interface SubagentConfig {
  /** System prompt for this subagent type */
  systemPrompt: string;
  /** Tools this subagent type can access */
  allowedTools: ToolName[];
  /** Recommended model for this subagent type */
  recommendedModel: string;
  /** Description of when to use this subagent type */
  description: string;
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
 * Configuration for each subagent type
 */
export const SUBAGENT_CONFIGS: Record<SubagentType, SubagentConfig> = {
  Explore: {
    systemPrompt: EXPLORE_SYSTEM_PROMPT,
    allowedTools: ["Glob", "Grep", "Read", "LS", "BashOutput"],
    recommendedModel: "anthropic/claude-haiku-4-20250514",
    description:
      "Fast agent for codebase exploration - finding files, searching code, understanding structure",
  },
  Plan: {
    systemPrompt: PLAN_SYSTEM_PROMPT,
    allowedTools: ["Glob", "Grep", "Read", "LS", "BashOutput"],
    recommendedModel: "anthropic/claude-haiku-4-20250514",
    description:
      "Planning agent that breaks down complex tasks into actionable steps",
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
    recommendedModel: "anthropic/claude-sonnet-4-5-20250929",
    description:
      "Full-capability agent for research, planning, and implementation",
  },
};

/**
 * Get subagent configuration for a given type
 */
export function getSubagentConfig(type: SubagentType): SubagentConfig {
  const config = SUBAGENT_CONFIGS[type];
  if (!config) {
    throw new Error(`Unknown subagent type: ${type}`);
  }
  return config;
}

/**
 * Check if a subagent type is valid
 */
export function isValidSubagentType(type: string): type is SubagentType {
  return type in SUBAGENT_CONFIGS;
}

/**
 * Get list of all available subagent types
 */
export function getAvailableSubagentTypes(): SubagentType[] {
  return Object.keys(SUBAGENT_CONFIGS) as SubagentType[];
}
