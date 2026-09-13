/**
 * System prompt resolution that can fall back to subagent prompts.
 *
 * Split from `prompt-assets.ts` so that the preset content itself stays pure
 * (bundleable for the browser-safe `agent-presets` package export) while the
 * subagent lookup — which touches the filesystem/backend — lives here.
 */

import {
  buildSystemPrompt,
  isKnownPreset,
  type MemoryPromptMode,
  SYSTEM_PROMPT,
  SYSTEM_PROMPTS,
} from "./prompt-assets";

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
    const { getAllSubagentConfigs } = await import("@/agent/subagents");
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

  const { getAllSubagentConfigs } = await import("@/agent/subagents");
  const subagentConfigs = await getAllSubagentConfigs();
  const matchedSubagent = subagentConfigs[systemPromptPreset];
  if (matchedSubagent) {
    return matchedSubagent.systemPrompt;
  }

  throw new Error(
    `Unknown system prompt "${systemPromptPreset}" — does not match any preset or subagent`,
  );
}
