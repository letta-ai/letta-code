const CONVERSATION_BUSY_ERROR_PATTERNS = [
  /another request is (?:currently )?(?:being )?processed/i,
  /currently being processed for this conversation/i,
  /busy with another active run/i,
  /already processing for this conversation/i,
  /turn still running/i,
];

export const CONVERSATION_BUSY_TITLE = "Turn still running";

export function isConversationBusyErrorText(
  errorText: string | null | undefined,
): boolean {
  if (!errorText) return false;
  return CONVERSATION_BUSY_ERROR_PATTERNS.some((pattern) =>
    pattern.test(errorText),
  );
}

export function buildConversationBusyErrorBody(
  automaticRetry: boolean,
): string {
  return automaticRetry
    ? "Another request is already processing for this conversation. I’ll wait for it to finish and retry automatically."
    : "Another request is already processing for this conversation. Please wait for it to finish, then try again.";
}

export function formatConversationBusyErrorMessage(options: {
  automaticRetry?: boolean;
  runId?: string;
}): string {
  const lines = [
    CONVERSATION_BUSY_TITLE,
    buildConversationBusyErrorBody(options.automaticRetry ?? false),
  ];
  if (options.runId) {
    lines.push("", `Run ID: ${options.runId}`);
  }
  return lines.join("\n");
}
