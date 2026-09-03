import type WebSocket from "ws";
import type { ResumeQueueCommand } from "@/types/queue-update-protocol";
import { scheduleQueuePump } from "@/websocket/listener/queue";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "@/websocket/listener/types";
import type { GetOrCreateScopedRuntime, SafeSocketSend } from "./types";

/**
 * `resume_queue`: release queue items parked by `abort_message` and pump the
 * queue so the released user messages start the next turn without a new
 * `input` message (the "Resume" affordance).
 */
export function handleResumeQueueCommand(
  command: ResumeQueueCommand,
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
