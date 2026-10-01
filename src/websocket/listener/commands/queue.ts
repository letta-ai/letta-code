import type WebSocket from "ws";
import type { RemoveQueueItemCommand } from "@/types/protocol_v2";
import type { ResumeQueueCommand } from "@/types/queue-update-protocol";
import { emitQueueUpdateIfOpen } from "@/websocket/listener/protocol-outbound";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";
import type { GetOrCreateScopedRuntime, SafeSocketSend } from "./types";

/** Mutate the listener's queue without submitting a new user message. */
export function handleQueueCommand(
  command: ResumeQueueCommand | RemoveQueueItemCommand,
  deps: {
    listener: ListenerRuntime;
    socket: WebSocket;
    opts: StartListenerOptions;
    processQueuedTurn: ProcessQueuedTurn;
    getOrCreateScopedRuntime: GetOrCreateScopedRuntime;
    safeSocketSend: SafeSocketSend;
  },
): void {
  const scopedRuntime = deps.getOrCreateScopedRuntime(
    deps.listener,
    command.runtime.agent_id,
    command.runtime.conversation_id || "default",
  );
  if (command.type === "remove_queue_item") {
    const removed = scopedRuntime.queueRuntime.removeItem(command.item_id);
    deps.safeSocketSend(
      deps.socket,
      {
        type: "remove_queue_item_response",
        request_id: command.request_id,
        success: removed !== null,
        item_id: command.item_id,
      },
      "remove_queue_item_response",
      "remove_queue_item",
    );
    // Even a missing item requires a snapshot to repair a stale client queue.
    emitQueueUpdateIfOpen(deps.listener, command.runtime);
    return;
  }

  const resumed = scopedRuntime.queueRuntime.resume();
  scheduleQueuePump(
    scopedRuntime,
    deps.socket,
    deps.opts,
    deps.processQueuedTurn,
  );
  if (command.request_id) {
    deps.safeSocketSend(
      deps.socket,
      {
        type: "resume_queue_response",
        request_id: command.request_id,
        runtime: command.runtime,
        resumed,
        success: true,
      },
      "resume_queue_response",
      "resume_queue",
    );
  }
}
