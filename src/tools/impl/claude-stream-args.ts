export function buildClaudeStreamArgs(options: {
  model?: string;
  mcpReminder?: string;
  resumeSessionId?: string;
  sessionId?: string;
  sessionName?: string;
  skillDirectories?: string[];
}): string[] {
  const args = [
    "--print",
    "--verbose",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    "--replay-user-messages",
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.sessionName && !options.resumeSessionId)
    args.push("--name", options.sessionName);
  if (options.mcpReminder)
    args.push("--append-system-prompt", options.mcpReminder);
  if (options.skillDirectories?.length)
    args.push("--add-dir", ...options.skillDirectories);
  return args;
}
