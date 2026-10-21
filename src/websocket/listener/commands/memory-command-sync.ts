import type WebSocket from "ws";
import { ensureMemfsSyncedForAgent } from "@/websocket/listener/memfs-sync";
import type { ListenerRuntime } from "@/websocket/listener/types";
import { handleMemoryProtocolCommand } from "./memory";
import type { RunDetachedListenerTask, SafeSocketSend } from "./types";

export function createMemfsSyncedTaskRunner(
  parsed: unknown,
  runtime: ListenerRuntime,
  runDetachedListenerTask: RunDetachedListenerTask,
): RunDetachedListenerTask {
  const command = parsed as { agent_id?: unknown; type?: unknown };
  const agentId = command.agent_id;
  if (typeof agentId !== "string" || command.type === "enable_memfs") {
    return runDetachedListenerTask;
  }

  return (commandName, task) => {
    runDetachedListenerTask(commandName, async () => {
      await ensureMemfsSyncedForAgent(runtime, agentId);
      await task();
    });
  };
}

export function handleMemfsSyncedMemoryProtocolCommand(
  parsed: unknown,
  context: {
    socket: WebSocket;
    runtime: ListenerRuntime;
    safeSocketSend: SafeSocketSend;
    runDetachedListenerTask: RunDetachedListenerTask;
  },
): boolean {
  return handleMemoryProtocolCommand(parsed, {
    socket: context.socket,
    safeSocketSend: context.safeSocketSend,
    runDetachedListenerTask: createMemfsSyncedTaskRunner(
      parsed,
      context.runtime,
      context.runDetachedListenerTask,
    ),
  });
}
