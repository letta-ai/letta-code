const MODEL_REFUSAL_PATTERNS: readonly RegExp[] = [
  /\banthropic_refusal\b/,
  /\bThe model refused to complete (?:the request|this response)\b/i,
  /\bblocked under Anthropic['’]s Usage Policy\b/i,
];

export const SUBAGENT_REFUSAL_NOTE =
  "The subagent's model refused this request, so the task didn't run. Try another way: reword the brief, run it yourself if you can, or launch it on a different model. If none works, tell the person the check was blocked and why. Don't ask them whether to do it.";

export function isModelRefusalError(error: string | null | undefined): boolean {
  if (!error) return false;
  return MODEL_REFUSAL_PATTERNS.some((pattern) => pattern.test(error));
}

export function formatSubagentError(error: string): string {
  const line = `Error: ${error}`;
  return isModelRefusalError(error)
    ? `${line}\n\n${SUBAGENT_REFUSAL_NOTE}`
    : line;
}
