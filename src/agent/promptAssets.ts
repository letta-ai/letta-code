// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import humanPrompt from "./prompts/human.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
// init_memory.md is now a bundled skill at src/skills/builtin/init/SKILL.md
import lettaPrompt from "./prompts/letta.md";
import sourceClaudePrompt from "./prompts/source_claude.md";
import sourceCodexPrompt from "./prompts/source_codex.md";
import sourceGeminiPrompt from "./prompts/source_gemini.md";

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
import systemPromptMemfsAddon from "./prompts/system_prompt_memfs.txt";
import systemPromptMemoryAddon from "./prompts/system_prompt_memory.txt";

export const SYSTEM_PROMPT = lettaPrompt;
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
    description: "Alias for letta",
    content: lettaPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta",
    label: "Letta Code",
    description: "Full Letta Code system prompt",
    content: lettaPrompt,
    isFeatured: true,
  },
  {
    id: "source-claude",
    label: "Claude Code",
    description: "Source-faithful Claude Code prompt (for benchmarking)",
    content: sourceClaudePrompt,
  },
  {
    id: "source-codex",
    label: "Codex",
    description: "Source-faithful OpenAI Codex prompt (for benchmarking)",
    content: sourceCodexPrompt,
  },
  {
    id: "source-gemini",
    label: "Gemini CLI",
    description: "Source-faithful Gemini CLI prompt (for benchmarking)",
    content: sourceGeminiPrompt,
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
 * @param systemPromptPreset - The system prompt preset (e.g., "letta", "source-claude") or subagent name (e.g., "explore")
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
