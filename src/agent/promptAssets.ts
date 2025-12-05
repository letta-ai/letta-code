// Additional system prompts for /system command

import anthropicPrompt from "./prompts/claude.md";
import codexPrompt from "./prompts/codex.md";
import geminiPrompt from "./prompts/gemini.md";
import humanPrompt from "./prompts/human.mdx";
import initializePrompt from "./prompts/init_memory.md";
import lettaAnthropicPrompt from "./prompts/letta_claude.md";
import lettaCodexPrompt from "./prompts/letta_codex.md";
import lettaGeminiPrompt from "./prompts/letta_gemini.md";
import loadedSkillsPrompt from "./prompts/loaded_skills.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaEmptyPrompt from "./prompts/persona_empty.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import skillUnloadReminder from "./prompts/skill_unload_reminder.txt";
import skillsPrompt from "./prompts/skills.mdx";
import stylePrompt from "./prompts/style.mdx";
import systemPrompt from "./prompts/system_prompt.txt";

export const SYSTEM_PROMPT = systemPrompt;
export const PLAN_MODE_REMINDER = planModeReminder;
export const SKILL_UNLOAD_REMINDER = skillUnloadReminder;
export const INITIALIZE_PROMPT = initializePrompt;
export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_empty.mdx": personaEmptyPrompt,
  "human.mdx": humanPrompt,
  "project.mdx": projectPrompt,
  "skills.mdx": skillsPrompt,
  "loaded_skills.mdx": loadedSkillsPrompt,
  "style.mdx": stylePrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
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
    description: "Standard Letta Code system prompt (Claude-optimized)",
    content: lettaAnthropicPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "legacy",
    label: "Legacy",
    description: "Original system prompt",
    content: systemPrompt,
  },
  {
    id: "letta-codex",
    label: "Codex",
    description: "For Codex models",
    content: lettaCodexPrompt,
    isFeatured: true,
  },
  {
    id: "letta-gemini",
    label: "Gemini",
    description: "For Gemini models",
    content: lettaGeminiPrompt,
    isFeatured: true,
  },
  {
    id: "anthropic",
    label: "Claude (basic)",
    description: "For Claude models (no skills/memory instructions)",
    content: anthropicPrompt,
  },
  {
    id: "codex",
    label: "Codex (basic)",
    description: "For Codex models (no skills/memory instructions)",
    content: codexPrompt,
  },
  {
    id: "gemini",
    label: "Gemini (basic)",
    description: "For Gemini models (no skills/memory instructions)",
    content: geminiPrompt,
  },
];

/**
 * Resolve a system prompt string to its content.
 *
 * Resolution order:
 * 1. If it matches a systemPromptId from SYSTEM_PROMPTS, use its content
 * 2. If it matches a subagent name, use that subagent's system prompt
 * 3. Otherwise, use the default system prompt
 *
 * @param systemPromptInput - The system prompt ID or subagent name
 * @returns The resolved system prompt content
 */
export async function resolveSystemPrompt(
  systemPromptInput: string | undefined,
): Promise<string> {
  // No input - use default
  if (!systemPromptInput) {
    return SYSTEM_PROMPT;
  }

  // 1. Check if it matches a system prompt ID
  const matchedPrompt = SYSTEM_PROMPTS.find((p) => p.id === systemPromptInput);
  if (matchedPrompt) {
    return matchedPrompt.content;
  }

  // 2. Check if it matches a subagent name
  const { getAllSubagentConfigs } = await import("./subagents");
  const subagentConfigs = await getAllSubagentConfigs();
  const matchedSubagent = subagentConfigs[systemPromptInput];
  if (matchedSubagent) {
    return matchedSubagent.systemPrompt;
  }

  // 3. Fall back to default
  return SYSTEM_PROMPT;
}
