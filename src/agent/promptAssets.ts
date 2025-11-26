import humanPrompt from "./prompts/human.mdx";

import personaPrompt from "./prompts/persona.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import skillModeReminder from "./prompts/skill_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import skillsPrompt from "./prompts/skills.mdx";
import stylePrompt from "./prompts/style.mdx";
import systemPrompt from "./prompts/system_prompt.txt";

export const SYSTEM_PROMPT = systemPrompt;
export const PLAN_MODE_REMINDER = planModeReminder;
export const SKILL_MODE_REMINDER = skillModeReminder;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "human.mdx": humanPrompt,
  "project.mdx": projectPrompt,
  "skills.mdx": skillsPrompt,
  "style.mdx": stylePrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
};
