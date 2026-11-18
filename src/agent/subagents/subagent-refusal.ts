/**
 * Model refusals reach the parent only as error text: the Letta API stop
 * reasons have no refusal value, and pi-ai maps Anthropic's `refusal` stop to
 * a generic error carrying the provider's explanation. Match the known
 * refusal phrasings narrowly so other failures keep their plain error.
 */
const MODEL_REFUSAL_PATTERNS: readonly RegExp[] = [
  // Letta API stop reason for an Anthropic refusal.
  /\banthropic_refusal\b/,
  // pi-ai fallback and Letta API message for a refused turn.
  /\bThe model refused to complete (?:the request|this response)\b/i,
  // Anthropic's policy explanation, e.g. "...was blocked under Anthropic's Usage Policy."
  /\bblocked under Anthropic['’]s Usage Policy\b/i,
];

export const SUBAGENT_REFUSAL_NOTE =
  "The subagent's model refused this request, so the task didn't run. Try another way: reword the brief, run it yourself if you can, or launch it on a different model. If none works, tell the person the check was blocked and why. Don't ask them whether to do it.";

/** Whether a subagent's error text says its model refused the request. */
export function isModelRefusalError(error: string | null | undefined): boolean {
  if (!error) return false;
  return MODEL_REFUSAL_PATTERNS.some((pattern) => pattern.test(error));
}

/** The `Error: ...` line the parent sees, plus guidance when the model refused. */
export function formatSubagentError(error: string): string {
  const line = `Error: ${error}`;
  return isModelRefusalError(error)
    ? `${line}\n\n${SUBAGENT_REFUSAL_NOTE}`
    : line;
}
