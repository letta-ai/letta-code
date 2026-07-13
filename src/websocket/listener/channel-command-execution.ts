import type { ChannelRegistry } from "@/channels/registry";
import { handleExecuteCommand } from "./commands";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import type { ListenerTransport } from "./transport";
import type { ListenerRuntime, StartListenerOptions } from "./types";

export function wireChannelExecuteCommand(
  registry: ChannelRegistry,
  listener: ListenerRuntime,
  socket: ListenerTransport,
  opts: StartListenerOptions,
): void {
  registry.setExecuteCommandHandler(async ({ runtime, commandId, args }) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      listener,
      runtime.agent_id,
      runtime.conversation_id,
    );
    const output = await handleExecuteCommand(
      {
        type: "execute_command",
        command_id: commandId,
        request_id: `channel-letta-${crypto.randomUUID()}`,
        runtime,
        ...(args ? { args } : {}),
      },
      socket,
      scopedRuntime,
      opts,
    );
    return { handled: true, text: output || `/${commandId} completed` };
  });
}
