// Additional system prompts for /system command

import anthropicPrompt from "./prompts/claude.md";
import codexPrompt from "./prompts/codex.md";
import geminiPrompt from "./prompts/gemini.md";
import humanPrompt from "./prompts/human.mdx";
import lettaAnthropicPrompt from "./prompts/letta_claude.md";
import lettaCodexPrompt from "./prompts/letta_codex.md";
import lettaGeminiPrompt from "./prompts/letta_gemini.md";
import loadedSkillsPrompt from "./prompts/loaded_skills.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import skillUnloadReminder from "./prompts/skill_unload_reminder.txt";
import skillsPrompt from "./prompts/skills.mdx";
import stylePrompt from "./prompts/style.mdx";
import systemPrompt from "./prompts/system_prompt.txt";

export const SYSTEM_PROMPT = systemPrompt;
export const PLAN_MODE_REMINDER = planModeReminder;
export const SKILL_UNLOAD_REMINDER = skillUnloadReminder;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
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
    description: "Standard Letta Code system prompt",
    content: systemPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta-anthropic",
    label: "Claude",
    description: "For Claude models",
    content: lettaAnthropicPrompt,
    isFeatured: true,
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
