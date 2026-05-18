/**
 * Conservative startup-context budgeting for subagents.
 *
 * We intentionally avoid tokenizer dependencies here. The estimate is used only
 * as a safety guard before sending prompts to the API; using 4 chars/token is
 * conservative enough for English/Markdown prompts while keeping the codepath
 * synchronous and dependency-free.
 */

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
