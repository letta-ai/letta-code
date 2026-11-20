export function buildClaudeStreamArgs(options: {
  model?: string;
  mcpReminder?: string;
  resumeSessionId?: string;
  sessionId?: string;
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
    // Echo each input back once Claude picks it up, so results can be matched
    // to the input they answer.
    "--replay-user-messages",
    // Subagents run unattended and nothing relays Claude Code permission
    // prompts back to the parent, so a gated tool call can only stall.
    "--permission-mode",
    "bypassPermissions",
  ];
  if (options.model) args.push("--model", options.model);
  if (options.resumeSessionId) args.push("--resume", options.resumeSessionId);
  else if (options.sessionId) args.push("--session-id", options.sessionId);
  if (options.mcpReminder)
    args.push("--append-system-prompt", options.mcpReminder);
  if (options.skillDirectories?.length)
    args.push("--add-dir", ...options.skillDirectories);
  return args;
}
