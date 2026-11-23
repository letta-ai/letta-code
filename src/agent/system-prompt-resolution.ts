import {
  buildSystemPrompt,
  isKnownPreset,
  type MemoryPromptMode,
  SYSTEM_PROMPT,
  SYSTEM_PROMPTS,
} from "./prompt-assets";

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
