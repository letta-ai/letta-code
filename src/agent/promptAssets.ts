// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import autoInitReminder from "./prompts/auto_init_reminder.txt";
import humanPrompt from "./prompts/human.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
// init_memory.md is now a bundled skill at src/skills/builtin/init/SKILL.md
import lettaPrompt from "./prompts/letta.md";
import memoryCheckReminder from "./prompts/memory_check_reminder.txt";
import memoryFilesystemPrompt from "./prompts/memory_filesystem.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaClaudePrompt from "./prompts/persona_claude.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import personaMemoPrompt from "./prompts/persona_memo.mdx";
import planModeReminder from "./prompts/plan_mode_reminder.txt";
import projectPrompt from "./prompts/project.mdx";
import rememberPrompt from "./prompts/remember.md";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import sourceClaudePrompt from "./prompts/source_claude.md";
import sourceCodexPrompt from "./prompts/source_codex.md";
import sourceGeminiPrompt from "./prompts/source_gemini.md";

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

export type MemoryPromptMode = "standard" | "memfs";

// --- Heading-aware section stripping (for legacy/custom prompts) ---

interface Heading {
  level: number;
  title: string;
  startOffset: number;
}

function scanHeadingsOutsideFences(text: string): Heading[] {
  const lines = text.split("\n");
  const headings: Heading[] = [];
  let inFence = false;
  let fenceToken = "";
  let offset = 0;

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = trimmed.match(/^(```+|~~~+)/);
    if (fenceMatch) {
      const token = fenceMatch[1] ?? fenceMatch[0] ?? "";
      const tokenChar = token.startsWith("`") ? "`" : "~";
      if (!inFence) {
        inFence = true;
        fenceToken = tokenChar;
      } else if (fenceToken === tokenChar) {
        inFence = false;
        fenceToken = "";
      }
    }

    if (!inFence) {
      const headingMatch = line.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
      if (headingMatch) {
        const hashes = headingMatch[1] ?? "";
        const rawTitle = headingMatch[2] ?? "";
        if (hashes && rawTitle) {
          const level = hashes.length;
          const title = rawTitle.replace(/\s+#*$/, "").trim();
          headings.push({ level, title, startOffset: offset });
        }
      }
    }

    offset += line.length + 1;
  }

  return headings;
}

function stripHeadingSections(
  text: string,
  shouldStrip: (heading: Heading) => boolean,
): string {
  let current = text;
  while (true) {
    const headings = scanHeadingsOutsideFences(current);
    const target = headings.find(shouldStrip);
    if (!target) return current;

    const nextHeading = headings.find(
      (h) => h.startOffset > target.startOffset && h.level <= target.level,
    );
    const end = nextHeading ? nextHeading.startOffset : current.length;
    current = `${current.slice(0, target.startOffset)}${current.slice(end)}`;
  }
}

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
  const addon =
    memoryMode === "memfs"
      ? SYSTEM_PROMPT_MEMFS_ADDON
      : SYSTEM_PROMPT_MEMORY_ADDON;
  return `${preset.content.trimEnd()}\n\n${addon.trimStart()}`.trim();
}

/**
 * Swap the memory addon on a custom/subagent/legacy prompt.
 * Strips all existing addons (handles duplicates) and orphan memfs tail fragments,
 * then appends the target addon.
 */
export function swapMemoryAddon(
  systemPrompt: string,
  mode: MemoryPromptMode,
): string {
  let result = systemPrompt;
  // Strip all existing addons (replaceAll handles duplicates)
  for (const addon of [
    SYSTEM_PROMPT_MEMORY_ADDON.trim(),
    SYSTEM_PROMPT_MEMFS_ADDON.trim(),
  ]) {
    result = result.replaceAll(addon, "");
  }
  // Strip orphan memfs tail fragment (from old drift bugs)
  const tailAnchor = "# See what changed";
  const tailStart = SYSTEM_PROMPT_MEMFS_ADDON.indexOf(tailAnchor);
  if (tailStart !== -1) {
    const orphanTail = SYSTEM_PROMPT_MEMFS_ADDON.slice(tailStart).trim();
    result = result.replaceAll(orphanTail, "");
  }
  // Strip legacy/variant memory sections by markdown heading parsing
  // (handles edited or older ## Memory / ## Memory Filesystem sections)
  result = stripHeadingSections(result, (h) => h.title === "Memory");
  result = stripHeadingSections(result, (h) =>
    h.title.startsWith("Memory Filesystem"),
  );
  // Compact blank lines and append target addon
  result = result.replace(/\n{3,}/g, "\n\n").trimEnd();
  const target =
    mode === "memfs" ? SYSTEM_PROMPT_MEMFS_ADDON : SYSTEM_PROMPT_MEMORY_ADDON;
  return `${result}\n\n${target.trimStart()}`.trim();
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
 * Resolve a prompt ID and build the full system prompt with memory addon.
 * Known presets are rebuilt deterministically; unknown IDs (subagent names)
 * are resolved async and have the addon swapped in.
 */
export async function resolveAndBuildSystemPrompt(
  promptId: string | undefined,
  memoryMode: MemoryPromptMode,
): Promise<string> {
  const id = promptId ?? "default";
  if (isKnownPreset(id)) {
    return buildSystemPrompt(id, memoryMode);
  }
  const resolved = await resolveSystemPrompt(id);
  return swapMemoryAddon(resolved, memoryMode);
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
 * @param systemPromptPreset - The system prompt preset (e.g., "letta", "source-claude") or subagent name (e.g., "explore")
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
