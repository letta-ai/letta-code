import type { ListenerTransport } from "@/websocket/listener/transport";
import type { ConversationRuntime } from "@/websocket/listener/types";
import { runCompactCommand } from "./compact-core";

/** /compact — Summarize conversation history through the active Backend. */
export async function handleCompactCommand(
  socket: ListenerTransport,
  conversationRuntime: ConversationRuntime,
  args: string | undefined,
): Promise<string> {
  return runCompactCommand({ socket, conversationRuntime, args });
}
