import { commands as registry } from "@/cli/commands/registry";
import { isRecord } from "@/utils/type-guards";

const sessionBuiltins = new Set([
  "/agents",
  "/clear",
  "/compact",
  "/connect",
  "/context",
  "/context-limit",
  "/dream",
  "/exit",
  "/help",
  "/init",
  "/login",
  "/logout",
  "/mcp",
  "/memory",
  "/model",
  "/new",
  "/reflect",
  "/rename",
  "/resume",
  "/skills",
  "/usage",
]);
export const terminalCommands = [
  ...Object.entries(registry)
    .filter(([cmd]) => sessionBuiltins.has(cmd))
    .map(([cmd, entry]) => ({
      cmd,
      desc: entry.desc,
      order: entry.order ?? 100,
    })),
  { cmd: "/history", desc: "Load older messages", order: 100 },
  {
    cmd: "/queue",
    desc: "Use /queue remove <number> or /queue resume",
    order: 100,
  },
];

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
  return [...commands.values()].sort((a, b) => a.order - b.order);
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
