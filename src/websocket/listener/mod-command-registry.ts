import type { ModCommand } from "@/mods/types";
import type { ModCommandInfo } from "@/types/protocol_v2";
import type { ListenerRuntime } from "./types";

function getLoadedModCommands(
  runtime: ListenerRuntime,
  agentId?: string | null,
): Map<string, ModCommand> {
  const commands = new Map<string, ModCommand>();
  const adapters = runtime.modAdapter ? [runtime.modAdapter] : [];
  const agentAdapter = agentId
    ? runtime.agentModAdapters?.get(agentId)
    : undefined;
  if (agentAdapter) adapters.push(agentAdapter);

  for (const adapter of adapters) {
    for (const command of Object.values(
      adapter.getSnapshot().registry.commands,
    )) {
      commands.set(command.id, command);
    }
  }
  return commands;
}

export function listListenerModCommands(
  runtime: ListenerRuntime,
  agentId?: string | null,
): ModCommandInfo[] {
  return Array.from(getLoadedModCommands(runtime, agentId).values()).map(
    (command) => ({
      id: command.id,
      description: command.description,
      ...(command.args ? { args: command.args } : {}),
    }),
  );
}

export function getListenerModCommand(
  runtime: ListenerRuntime,
  commandId: string,
  agentId?: string | null,
): ModCommand | undefined {
  return getLoadedModCommands(runtime, agentId).get(commandId);
}
