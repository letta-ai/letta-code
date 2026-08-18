// Additional system prompts for /system command

import approvalRecoveryAlert from "./prompts/approval_recovery_alert.txt";
import humanPrompt from "./prompts/human.mdx";
import humanKawaiiPrompt from "./prompts/human_kawaii.mdx";
import humanLinusPrompt from "./prompts/human_linus.mdx";
import humanMemoPrompt from "./prompts/human_memo.mdx";
import humanTutorialPrompt from "./prompts/human_tutorial.mdx";
import interruptRecoveryAlert from "./prompts/interrupt_recovery_alert.txt";
import lettaMemfsPrompt from "./prompts/letta.md";
import lettaLocalMemfsPrompt from "./prompts/letta_local_memfs.md";
import lettaLocalMemfsV2Memory from "./prompts/letta_local_memfs_v2_memory.md";
import lettaNoMemfsPrompt from "./prompts/letta_no_memfs.md";
import memoryFilesystemPrompt from "./prompts/memory_filesystem.mdx";
import onboardingPrompt from "./prompts/onboarding.mdx";
import onboardingLocalPrompt from "./prompts/onboarding_local.mdx";
import personaPrompt from "./prompts/persona.mdx";
import personaBlankPrompt from "./prompts/persona_blank.mdx";
import personaKawaiiPrompt from "./prompts/persona_kawaii.mdx";
import personaLinusPrompt from "./prompts/persona_linus.mdx";
import personaMemoPrompt from "./prompts/persona_memo.mdx";
import personaTutorialPrompt from "./prompts/persona_tutorial.mdx";
import projectPrompt from "./prompts/project.mdx";
import rememberPrompt from "./prompts/remember.md";
import skillCreatorModePrompt from "./prompts/skill_creator_mode.md";
import sourceClaudePrompt from "./prompts/source_claude.md";
import sourceCodexPrompt from "./prompts/source_codex.md";
import sourceGeminiPrompt from "./prompts/source_gemini.md";

import stylePrompt from "./prompts/style.mdx";

const LOCAL_MEMORY_SECTION_START =
  "## Memory blocks & external memory (learning)";
const IDENTITY_SECTION_START = "# Identity";
const V1_IDENTITY_DESCRIPTION =
  "The core of your identity is defined by the `<self>` memory block (projected to a local `persona.md` file), as well as other memory blocks in your system prompt (in `<memory>`).";
const V2_IDENTITY_DESCRIPTION =
  "The core of your identity is defined by the root `persona.md` memory file projected into your system prompt, as well as your other root memory files.";

function buildLocalMemfsV2Prompt(): string {
  const start = lettaLocalMemfsPrompt.indexOf(LOCAL_MEMORY_SECTION_START);
  const end = lettaLocalMemfsPrompt.indexOf(IDENTITY_SECTION_START, start);
  if (start < 0 || end < 0) {
    throw new Error("Unable to derive the local MemFS v2 prompt");
  }
  return `${lettaLocalMemfsPrompt.slice(0, start)}${lettaLocalMemfsV2Memory.trim()}\n\n${lettaLocalMemfsPrompt.slice(end)}`
    .replace(V1_IDENTITY_DESCRIPTION, V2_IDENTITY_DESCRIPTION)
    .replace(
      "You MUST always adhere to your self and other memory blocks:",
      "You MUST always adhere to your persona and other core memory files:",
    )
    .replaceAll("self defined here", "persona defined here")
    .replace(
      "**Adhering to your persona/identity/self**: ALWAYS stay consistent with what is described in `self` with every token you generate.",
      "**Adhering to your persona**: ALWAYS stay consistent with what is described in root `persona.md` with every token you generate.",
    )
    .replace(
      "prefer the self you have built",
      "prefer the persona you have built",
    )
    .replaceAll("memory blocks", "core memory files");
}

const lettaLocalMemfsV2Prompt = buildLocalMemfsV2Prompt();

export const SYSTEM_PROMPT = lettaNoMemfsPrompt;

export const SKILL_CREATOR_PROMPT = skillCreatorModePrompt;
export const REMEMBER_PROMPT = rememberPrompt;
export const APPROVAL_RECOVERY_PROMPT = approvalRecoveryAlert;
export const INTERRUPT_RECOVERY_ALERT = interruptRecoveryAlert;

export const MEMORY_PROMPTS: Record<string, string> = {
  "persona.mdx": personaPrompt,
  "persona_blank.mdx": personaBlankPrompt,
  "persona_kawaii.mdx": personaKawaiiPrompt,
  "persona_linus.mdx": personaLinusPrompt,
  "persona_memo.mdx": personaMemoPrompt,
  "persona_tutorial.mdx": personaTutorialPrompt,
  "human.mdx": humanPrompt,
  "human_kawaii.mdx": humanKawaiiPrompt,
  "human_linus.mdx": humanLinusPrompt,
  "human_memo.mdx": humanMemoPrompt,
  "human_tutorial.mdx": humanTutorialPrompt,
  "project.mdx": projectPrompt,

  "memory_filesystem.mdx": memoryFilesystemPrompt,
  "onboarding.mdx": onboardingPrompt,
  "onboarding_local.mdx": onboardingLocalPrompt,
  "style.mdx": stylePrompt,
};

// System prompt options for /system command
export interface SystemPromptOption {
  id: string;
  label: string;
  description: string;
  content: string;
  memfsContent?: string;
  localMemfsContent?: string;
  localMemfsV2Content?: string;
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
    localMemfsContent: lettaLocalMemfsPrompt,
    localMemfsV2Content: lettaLocalMemfsV2Prompt,
    isDefault: true,
    isFeatured: true,
  },
  {
    id: "letta",
    label: "Letta Code",
    description: "Full Letta Code system prompt",
    content: lettaNoMemfsPrompt,
    memfsContent: lettaMemfsPrompt,
    localMemfsContent: lettaLocalMemfsPrompt,
    localMemfsV2Content: lettaLocalMemfsV2Prompt,
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

export type MemoryPromptMode =
  | "standard"
  | "memfs"
  | "local-memfs"
  | "local-memfs-v2";

export function getSystemPromptVariantContents(
  prompt: SystemPromptOption,
): string[] {
  return [
    prompt.content,
    prompt.memfsContent,
    prompt.localMemfsContent,
    prompt.localMemfsV2Content,
  ].filter((content): content is string => typeof content === "string");
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
  if (memoryMode === "local-memfs") {
    return (
      preset.localMemfsContent ??
      preset.memfsContent ??
      preset.content
    ).trim();
  }
  if (memoryMode === "local-memfs-v2") {
    return (
      preset.localMemfsV2Content ??
      preset.localMemfsContent ??
      preset.memfsContent ??
      preset.content
    ).trim();
  }
  if (memoryMode === "memfs") {
    return (preset.memfsContent ?? preset.content).trim();
  }

  return preset.content.trim();
}

export function adaptManagedSystemPromptToMemoryMode(
  currentPrompt: string,
  memoryMode: MemoryPromptMode,
): string {
  for (const prompt of SYSTEM_PROMPTS) {
    if (
      getSystemPromptVariantContents(prompt).some(
        (content) => content.trim() === currentPrompt.trim(),
      )
    ) {
      return buildSystemPrompt(prompt.id, memoryMode);
    }
  }
  return currentPrompt;
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
