const INTERACTIVE_SLASH_COMMANDS = new Set([
  "/model",
  "/experiments",
  "/toolset",
  "/system",
  "/personality",
  "/subagents",
  "/memory",
  "/sleeptime",
  "/mcp",
  "/help",
  "/agents",
  "/resume",
  "/pinned",
  "/profiles",
  "/search",
  "/feedback",
  "/pin",
  "/conversations",
  "/profile",
]);

const NON_STATE_COMMANDS = new Set([
  "/ade",
  "/bg",
  "/workflows",
  "/btw",
  "/usage",
  "/help",
  "/hooks",
  "/search",
  "/memory",
  "/feedback",
  "/mods",
  "/reasoning-tab",
  "/secret",
  "/palace",
  "/exit",
  "/rename",
  "/btw",
  "/reload",
  "/dream",
  "/reflect",
  "/reflection",
]);

export function aliasBareExitCommand(input: string): string {
  if (input === "exit" || input === "quit") return "/exit";
  return input;
}

export function isInteractiveCommand(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  if (INTERACTIVE_SLASH_COMMANDS.has(trimmed)) return true;
  for (const cmd of INTERACTIVE_SLASH_COMMANDS) {
    if (trimmed.startsWith(`${cmd} `)) return true;
  }
  return false;
}

export function isNonStateCommand(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  if (NON_STATE_COMMANDS.has(trimmed)) return true;
  for (const cmd of NON_STATE_COMMANDS) {
    if (trimmed.startsWith(`${cmd} `)) return true;
  }
  return false;
}

export function shouldSlashCommandBypassQueue(
  msg: string,
  options: {
    hasCustomCommand?: boolean;
    modCommand?: { runWhenBusy: boolean };
  } = {},
): boolean {
  if (options.hasCustomCommand) return false;
  if (options.modCommand) return options.modCommand.runWhenBusy;
  return isInteractiveCommand(msg) || isNonStateCommand(msg);
}
