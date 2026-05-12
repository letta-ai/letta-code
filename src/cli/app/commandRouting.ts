// Interactive slash commands that open overlays immediately (bypass queueing)
// These commands let users browse/view while the agent is working
// Any changes made in the overlay will be queued until end_turn
const INTERACTIVE_SLASH_COMMANDS = new Set([
  "/model",
  "/experiments",
  "/toolset",
  "/system",
  "/personality",
  "/subagents",
  "/memory",
  "/goal",
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
  "/pin-local",
  "/conversations",
  "/profile",
]);

// Non-state commands that should run immediately while the agent is busy
// These don't modify agent state, so they should bypass queueing
const NON_STATE_COMMANDS = new Set([
  "/ade",
  "/bg",
  "/btw",
  "/usage",
  "/help",
  "/hooks",
  "/search",
  "/memory",
  "/goal",
  "/feedback",
  "/export",
  "/download",
  "/statusline",
  "/reasoning-tab",
  "/secret",
  "/palace", // read-only memory viewer
  "/exit", // session exit
  "/rename", // agent/convo rename
  "/btw",
]);

// Check if a command is interactive (opens overlay, should not be queued)
export function isInteractiveCommand(msg: string): boolean {
  const trimmed = msg.trim().toLowerCase();
  // Check exact matches first
  if (INTERACTIVE_SLASH_COMMANDS.has(trimmed)) return true;
  // Check prefix matches for commands with arguments
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
