import gpt51Prompt from "./prompts/gpt_5_1_prompt.md";
import gpt5CodexPrompt from "./prompts/gpt_5_codex_prompt.md";
// Additional system prompts for /system command
import gptPrompt from "./prompts/gpt_prompt.md";
import gptReviewPrompt from "./prompts/gpt_review_prompt.md";
import gpt51CodexMaxPrompt from "./prompts/gpt-5.1-codex-max_prompt.md";
import humanPrompt from "./prompts/human.mdx";
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
    id: "gpt",
    label: "GPT",
    description: "For gpt-4.x, gpt-5, o3, o4 models",
    content: gptPrompt,
  },
  {
    id: "gpt-5.1",
    label: "GPT-5.1",
    description: "For gpt-5.1 (non-codex) models",
    content: gpt51Prompt,
  },
  {
    id: "gpt-5-codex",
    label: "GPT-5 Codex",
    description: "For gpt-5-codex, gpt-5.1-codex, codex-* models",
    content: gpt5CodexPrompt,
    isFeatured: true,
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
    description: "For gpt-5.1-codex-max (latest)",
    content: gpt51CodexMaxPrompt,
    isFeatured: true,
  },
  {
    id: "gpt-review",
    label: "GPT Review",
    description: "Code review focused prompt",
    content: gptReviewPrompt,
  },
];
