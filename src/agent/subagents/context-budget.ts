/**
 * Conservative startup-context budgeting for subagents.
 *
 * We intentionally avoid tokenizer dependencies here. The estimate is used only
 * as a safety guard before sending prompts to the API; using 4 chars/token is
 * conservative enough for English/Markdown prompts while keeping the codepath
 * synchronous and dependency-free.
 */

import type { SubagentConfig } from ".";

export const STARTUP_CONTEXT_ESTIMATED_CHARS_PER_TOKEN = 4;
export const REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT = 16_000;
export const REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT =
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT *
  STARTUP_CONTEXT_ESTIMATED_CHARS_PER_TOKEN;

// Leave room for the reflection subagent system prompt and launch boilerplate.
// The final guard in subagent manager enforces the full system+prompt budget.
export const REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT = 40_000;

export function estimateStartupContextTokens(text: string): number {
  return Math.ceil(text.length / STARTUP_CONTEXT_ESTIMATED_CHARS_PER_TOKEN);
}

function getReflectionStartupNotice(): string {
  return `[Reflection startup context truncated: system prompt + initial message are capped at ~${REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT.toLocaleString()} estimated tokens. Some parent memory preview content was omitted; read files directly from MEMORY_DIR if needed.]`;
}

function buildMinimalParentMemorySection(maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const section = `<parent_memory>\n${notice}\n</parent_memory>`;
  if (section.length <= maxChars) return section;
  return section.slice(0, Math.max(0, maxChars));
}

function shrinkParentMemorySection(section: string, maxChars: number): string {
  const notice = getReflectionStartupNotice();
  const treeMatch = section.match(
    /<memory_filesystem>[\s\S]*?<\/memory_filesystem>/,
  );
  const prefix = "<parent_memory>\n";
  const suffix = "\n</parent_memory>";
  const tree = treeMatch?.[0];
  if (tree) {
    const candidate = `${prefix}${tree}\n${notice}${suffix}`;
    if (candidate.length <= maxChars) return candidate;
  }
  return buildMinimalParentMemorySection(maxChars);
}

function hardTruncateReflectionPrompt(
  prompt: string,
  maxChars: number,
): string {
  const notice = `\n${getReflectionStartupNotice()}`;
  if (maxChars <= notice.length) return notice.slice(0, Math.max(0, maxChars));
  return `${prompt.slice(0, maxChars - notice.length).trimEnd()}${notice}`;
}

export function buildSubagentPrompt(
  type: string,
  config: SubagentConfig,
  userPrompt: string,
): string {
  if (type !== "reflection") return userPrompt;
  const systemPrompt = config.systemPrompt;
  const estimatedTokens = estimateStartupContextTokens(
    `${systemPrompt}\n${userPrompt}`,
  );
  if (estimatedTokens <= REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT)
    return userPrompt;
  const allowedPromptChars = Math.max(
    0,
    REFLECTION_STARTUP_CONTEXT_CHAR_LIMIT - systemPrompt.length - 1,
  );
  const parentMemoryMatch = userPrompt.match(
    /<parent_memory>[\s\S]*?<\/parent_memory>/,
  );
  if (parentMemoryMatch?.index !== undefined) {
    const start = parentMemoryMatch.index;
    const end = start + parentMemoryMatch[0].length;
    const outsideChars = userPrompt.length - parentMemoryMatch[0].length;
    const parentMemoryBudget = Math.max(0, allowedPromptChars - outsideChars);
    const replacement = shrinkParentMemorySection(
      parentMemoryMatch[0],
      parentMemoryBudget,
    );
    const candidate = `${userPrompt.slice(0, start)}${replacement}${userPrompt.slice(end)}`;
    if (candidate.length <= allowedPromptChars) return candidate;
  }
  return hardTruncateReflectionPrompt(userPrompt, allowedPromptChars);
}
