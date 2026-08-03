import type { ChannelRegistry } from "@/channels/registry";
import { handleCompactCommand, handleReloadCommand } from "./commands";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import type { ListenerTransport } from "./transport";
import type { ListenerRuntime } from "./types";

export function wireChannelRuntimeCommands(params: {
  registry: ChannelRegistry;
  listener: ListenerRuntime;
  socket: ListenerTransport;
}): void {
  const { registry, listener, socket } = params;

  registry.setCompactHandler(async ({ runtime, args }) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      listener,
      runtime.agent_id,
      runtime.conversation_id,
    );
    try {
      return {
        handled: true,
        text: await handleCompactCommand(socket, scopedRuntime, args),
      };
    } catch (error) {
      return {
        handled: true,
        text: `Failed to compact this conversation: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });

  registry.setReloadHandler(async ({ runtime }) => {
    const scopedRuntime = getOrCreateScopedRuntime(
      listener,
      runtime.agent_id,
      runtime.conversation_id,
    );
    try {
      const output = await handleReloadCommand(scopedRuntime);
      emitDeviceStatusUpdate(socket, scopedRuntime, runtime);
      return {
        handled: true,
        text: output,
      };
    } catch (error) {
      return {
        handled: true,
        text: `Failed to reload listener settings: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
}
