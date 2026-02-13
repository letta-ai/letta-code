// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import anthropicPrompt from "./prompts/claude.md";
import codexPrompt from "./prompts/codex.md";
import geminiPrompt from "./prompts/gemini.md";
import humanPrompt from "./prompts/human.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
// init_memory.md is now a bundled skill at src/skills/builtin/init/SKILL.md
import lettaAnthropicPrompt from "./prompts/letta_claude.md";
import lettaCodexPrompt from "./prompts/letta_codex.md";
import lettaGeminiPrompt from "./prompts/letta_gemini.md";

import memoryCheckReminder from "./prompts/memory_check_reminder.txt";
import memoryFilesystemPrompt from "./prompts/memory_filesystem.mdx";
import memoryReflectionReminder from "./prompts/memory_reflection_reminder.txt";
import personaPrompt from "./prompts/persona.mdx";
import personaClaudePrompt from "./prompts/persona_claude.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import personaMemoPrompt from "./prompts/persona_memo.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import rememberPrompt from "./prompts/remember.md";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";

import stylePrompt from "./prompts/style.mdx";
import systemPrompt from "./prompts/system_prompt.txt";
import systemPromptMemfsAddon from "./prompts/system_prompt_memfs.txt";
import systemPromptMemoryAddon from "./prompts/system_prompt_memory.txt";

export const SYSTEM_PROMPT = systemPrompt;
export const SYSTEM_PROMPT_MEMORY_ADDON = systemPromptMemoryAddon;
export const SYSTEM_PROMPT_MEMFS_ADDON = systemPromptMemfsAddon;
export const PLAN_MODE_REMINDER = planModeReminder;

export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;
export const REMEMBER_PROMPT = rememberPrompt;
export const MEMORY_CHECK_REMINDER = memoryCheckReminder;
export const MEMORY_REFLECTION_REMINDER = memoryReflectionReminder;
export const APPROVAL_RECOVERY_PROMPT = approvalRecoveryAlert;
export const INTERRUPT_RECOVERY_ALERT = interruptRecoveryAlert;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_claude.mdx": personaClaudePrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
  "persona_memo.mdx": personaMemoPrompt,
  "human.mdx": humanPrompt,
  "project.mdx": projectPrompt,

  "memory_filesystem.mdx": memoryFilesystemPrompt,
  "style.mdx": stylePrompt,
};

// System prompt options for /system command
export interface SystemPromptOption {
  id: string;
  label: string;
  description: string;
  content: string;
  isDefault?: boolean;
  isFeatured?: boolean;
}

export const SYSTEM_PROMPTS: SystemPromptOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Alias for letta-claude",
    content: lettaAnthropicPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta-claude",
    label: "Letta Claude",
    description: "Full Letta Code system prompt (Claude-optimized)",
    content: lettaAnthropicPrompt,
    isFeatured: true,
  },
  {
    id: "letta-codex",
    label: "Letta Codex",
    description: "Full Letta Code system prompt (Codex-optimized)",
    content: lettaCodexPrompt,
    isFeatured: true,
  },
  {
    id: "letta-gemini",
    label: "Letta Gemini",
    description: "Full Letta Code system prompt (Gemini-optimized)",
    content: lettaGeminiPrompt,
    isFeatured: true,
  },
  {
    id: "claude",
    label: "Claude (basic)",
    description: "Basic Claude prompt (no skills/memory instructions)",
    content: anthropicPrompt,
  },
  {
    id: "codex",
    label: "Codex (basic)",
    description: "Basic Codex prompt (no skills/memory instructions)",
    content: codexPrompt,
  },
  {
    id: "gemini",
    label: "Gemini (basic)",
    description: "Basic Gemini prompt (no skills/memory instructions)",
    content: geminiPrompt,
  },
];

/**
 * Resolve a system prompt ID to its content.
 *
 * Resolution order:
 * 1. If it matches an ID from SYSTEM_PROMPTS, use its content
 * 2. If it matches a subagent name, use that subagent's system prompt
 * 3. Otherwise, use the default system prompt
 *
 * @param systemPromptPreset - The system prompt preset (e.g., "letta-claude") or subagent name (e.g., "explore")
 * @returns The resolved system prompt content
 */
export async function resolveSystemPrompt(
  systemPromptPreset: string | undefined,
): Promise<string> {
  // No input - use default
  if (!systemPromptPreset) {
    return SYSTEM_PROMPT;
  }

  // 1. Check if it matches a system prompt ID
  const matchedPrompt = SYSTEM_PROMPTS.find((p) => p.id === systemPromptPreset);
  if (matchedPrompt) {
    return matchedPrompt.content;
  }

  // 2. Check if it matches a subagent name
  const { getAllSubagentConfigs } = await import("./subagents");
  const subagentConfigs = await getAllSubagentConfigs();
  const matchedSubagent = subagentConfigs[systemPromptPreset];
  if (matchedSubagent) {
    return matchedSubagent.systemPrompt;
  }

  // 3. Fall back to default
  return SYSTEM_PROMPT;
}
