// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import humanPrompt from "./prompts/human.mdx";
import humanKawaiiPrompt from "./prompts/human_kawaii.mdx";
import humanLinusPrompt from "./prompts/human_linus.mdx";
import humanMemoPrompt from "./prompts/human_memo.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
import lettaMemfsPrompt from "./prompts/letta.md";
import lettaNoMemfsPrompt from "./prompts/letta_no_memfs.md";
import memoryCheckReminder from "./prompts/memory_check_reminder.txt";
import memoryFilesystemPrompt from "./prompts/memory_filesystem.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import personaLinusPrompt from "./prompts/persona_linus.mdx";
import personaMemoPrompt from "./prompts/persona_memo.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import rememberPrompt from "./prompts/remember.md";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import sleeptimePersona from "./prompts/sleeptime.md";
import sourceClaudePrompt from "./prompts/source_claude.md";
import sourceCodexPrompt from "./prompts/source_codex.md";
import sourceGeminiPrompt from "./prompts/source_gemini.md";

import stylePrompt from "./prompts/style.mdx";

export const SYSTEM_PROMPT = lettaNoMemfsPrompt;
export const PLAN_MODE_REMINDER = planModeReminder;

export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;
export const REMEMBER_PROMPT = rememberPrompt;
export const MEMORY_CHECK_REMINDER = memoryCheckReminder;
export const APPROVAL_RECOVERY_PROMPT = approvalRecoveryAlert;
export const INTERRUPT_RECOVERY_ALERT = interruptRecoveryAlert;
export const SLEEPTIME_MEMORY_PERSONA = sleeptimePersona;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
  "persona_linus.mdx": personaLinusPrompt,
  "persona_memo.mdx": personaMemoPrompt,
  "human.mdx": humanPrompt,
  "human_kawaii.mdx": humanKawaiiPrompt,
  "human_linus.mdx": humanLinusPrompt,
  "human_memo.mdx": humanMemoPrompt,
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
  memfsContent?: string;
  isDefault?: boolean;
  isFeatured?: boolean;
}

export const SYSTEM_PROMPTS: SystemPromptOption[] = [
  {
    id: "default",
    label: "Default",
    description: "Alias for letta",
    content: lettaNoMemfsPrompt,
    memfsContent: lettaMemfsPrompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta",
    label: "Letta Code",
    description: "Full Letta Code system prompt",
    content: lettaNoMemfsPrompt,
    memfsContent: lettaMemfsPrompt,
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

export type MemoryPromptMode = "standard" | "memfs";

/**
 * Check if a preset ID exists in SYSTEM_PROMPTS.
 */
export function isKnownPreset(id: string): boolean {
  return SYSTEM_PROMPTS.some((p) => p.id === id);
}

/**
 * Deterministic rebuild of a system prompt from a known preset + memory mode.
 * Throws on unknown preset (prevents stale/renamed presets from silently rewriting prompts).
 */
export function buildSystemPrompt(
  presetId: string,
  memoryMode: MemoryPromptMode,
): string {
  const preset = SYSTEM_PROMPTS.find((p) => p.id === presetId);
  if (!preset) {
    throw new Error(
      `Unknown preset "${presetId}" — cannot rebuild system prompt`,
    );
  }
  if (memoryMode === "memfs") {
    return (preset.memfsContent ?? preset.content).trim();
  }

  return preset.content.trim();
}

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
 * Returns true if the agent is not on the current default preset
 * and would benefit from switching to `/system default`.
 */
export function shouldRecommendDefaultPrompt(
  currentPrompt: string,
  memoryMode: MemoryPromptMode,
): boolean {
  const defaultPrompt = buildSystemPrompt("default", memoryMode);
  return currentPrompt !== defaultPrompt;
}

/**
 * Resolve a prompt ID and build the full system prompt for the memory mode.
 * Known presets are rebuilt deterministically. Unknown IDs (subagent names)
 * are resolved as complete prompts and are not modified.
 */
export async function resolveAndBuildSystemPrompt(
  promptId: string | undefined,
  memoryMode: MemoryPromptMode,
): Promise<string> {
  const id = promptId ?? "default";
  if (isKnownPreset(id)) {
    return buildSystemPrompt(id, memoryMode);
  }
  return resolveSystemPrompt(id);
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
 * @param systemPromptPreset - The system prompt preset (e.g., "letta", "source-claude") or subagent name (e.g., "recall")
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
