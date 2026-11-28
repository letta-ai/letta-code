import { isRecord } from "@/utils/type-guards";
export const terminalCommands = Object.entries({
  agents: "Browse agents (pinned, Letta Code, all)",
  clear: "Clear in-context messages",
  compact: "Summarize conversation history (compaction) with optional mode",
  connect: "Connect your LLM API keys (OpenAI, Anthropic, etc.)",
  context: "Show context window usage",
  "context-limit": "Set or reset the max context window",
  dream:
    "Reflect on memory (alias for /reflect; Cloud reflects this conversation)",
  exit: "Exit this session",
  help: "Show available commands",
  history: "Load older messages",
  init: "Initialize (or re-init) your agent's memory",
  login: "Sign in with Letta",
  logout: "Clear saved credentials and exit",
  mcp: "Manage MCP servers (add, connect with OAuth)",
  memory: "View your agent's memory",
  model: "Switch model",
  new: "Start a new conversation (keep agent memory)",
  queue: "Use /queue remove <number> or /queue resume",
  reflect:
    "Launch reflection (/reflect [--recent N | --conversation ID ... | --auto] [--instruction TEXT])",
  rename: "Rename agent or conversation (/rename agent [name]|convo [name])",
  resume: "Resume a previous conversation",
  skills: "Browse available skills",
  usage: "Show session usage statistics and balance",
}).map(([name, desc], order) => ({ cmd: `/${name}`, desc, order }));

function serverCommands(entries: unknown) {
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) =>
    isRecord(entry) &&
    typeof entry.id === "string" &&
    typeof entry.description === "string"
      ? [{ cmd: `/${entry.id}`, desc: entry.description, order: 100 }]
      : [],
  );
}

export function sessionCommands(raw?: Record<string, unknown>) {
  const commands = new Map(
    terminalCommands.map((command) => [command.cmd, command]),
  );
  for (const command of serverCommands(raw?.mod_commands))
    commands.set(command.cmd, command);
  for (const command of serverCommands(raw?.current_available_skills)) {
    if (!commands.has(command.cmd)) commands.set(command.cmd, command);
  }
  return [...commands.values()];
}

export function isSessionSkillCommand(
  id: string,
  raw?: Record<string, unknown>,
) {
  const name = `/${id}`;
  return (
    !terminalCommands.some((command) => command.cmd === name) &&
    !serverCommands(raw?.mod_commands).some(
      (command) => command.cmd === name,
    ) &&
    serverCommands(raw?.current_available_skills).some(
      (command) => command.cmd === name,
    )
  );
}
