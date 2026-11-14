/** Limit the caller's assignment, excluding harness-provided history. */
export const FORK_PROMPT_CHARACTER_LIMIT = 2_000;

export function validateForkPrompt(
  prompt: string,
  forked: boolean,
): string | undefined {
  if (!forked || prompt.length <= FORK_PROMPT_CHARACTER_LIMIT) return;
  return `Forked prompt is ${prompt.length} characters; the limit is ${FORK_PROMPT_CHARACTER_LIMIT}. The agent already has the conversation. Send only the go, what done looks like, and what to read.`;
}
