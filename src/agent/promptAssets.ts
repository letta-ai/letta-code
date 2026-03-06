// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import autoInitReminder from "./prompts/auto_init_reminder.txt";
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
export const AUTO_INIT_REMINDER = autoInitReminder;
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
    description: "Letta-tuned system prompt",
    content: systemPrompt,
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
 * Validate a system prompt preset ID.
 *
 * Known preset IDs are always accepted. Subagent names are only accepted
 * when `allowSubagentNames` is true (internal subagent launches).
 *
 * @throws Error with a descriptive message listing valid options
 */
export async function validateSystemPromptPreset(
  id: string,
  opts?: { allowSubagentNames?: boolean },
): Promise<void> {
  const validPresets = SYSTEM_PROMPTS.map((p) => p.id);
  if (validPresets.includes(id)) return;

  if (opts?.allowSubagentNames) {
    const { getAllSubagentConfigs } = await import("./subagents");
    const subagentConfigs = await getAllSubagentConfigs();
    if (subagentConfigs[id]) return;

    const allValid = [...validPresets, ...Object.keys(subagentConfigs)];
    throw new Error(
      `Invalid system prompt "${id}". Must be one of: ${allValid.join(", ")}.`,
    );
  }

  throw new Error(
    `Invalid system prompt "${id}". Must be one of: ${validPresets.join(", ")}.`,
  );
}

/**
 * Resolve a system prompt ID to its content.
 *
 * Resolution order:
 * 1. No input → default system prompt
 * 2. Known preset ID → preset content
 * 3. Subagent name → subagent's system prompt
 * 4. Unknown → throws (callers should validate first via validateSystemPromptPreset)
 *
 * @param systemPromptPreset - The system prompt preset (e.g., "letta-claude") or subagent name (e.g., "explore")
 * @returns The resolved system prompt content
 * @throws Error if the ID doesn't match any preset or subagent
 */
export async function resolveSystemPrompt(
  systemPromptPreset: string | undefined,
): Promise<string> {
  if (!systemPromptPreset) {
    return SYSTEM_PROMPT;
  }

  const matchedPrompt = SYSTEM_PROMPTS.find((p) => p.id === systemPromptPreset);
  if (matchedPrompt) {
    return matchedPrompt.content;
  }

  const { getAllSubagentConfigs } = await import("./subagents");
  const subagentConfigs = await getAllSubagentConfigs();
  const matchedSubagent = subagentConfigs[systemPromptPreset];
  if (matchedSubagent) {
    return matchedSubagent.systemPrompt;
  }

  throw new Error(
    `Unknown system prompt "${systemPromptPreset}" — does not match any preset or subagent`,
  );
}
