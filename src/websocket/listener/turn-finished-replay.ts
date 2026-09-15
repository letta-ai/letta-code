import { toListenerConnection } from "./connection";
import { emitProtocolV2Message } from "./protocol-outbound";
import { evictConversationRuntimeIfIdle } from "./runtime";
import { isListenerTransportOpen } from "./transport";
import type { ConversationRuntime, ListenerConnectionId } from "./types";

/**
 * Sends the `turn_finished` frame that `finishListenerTurn` could not deliver
 * because no connection was open when the turn ended. The frame goes to this
 * one connection and is then forgotten, so a second sync or reconnect does not
 * send it again.
 */
export function replayUndeliveredTurnFinishedToConnection(
  runtime: ConversationRuntime,
  connectionId: ListenerConnectionId,
): void {
  const pending = runtime.undeliveredTurnFinished;
  if (!pending) {
    return;
  }
  const connection = runtime.listener.connections.get(connectionId);
  if (!connection?.initialized || !isListenerTransportOpen(connection.writer)) {
    return;
  }
  runtime.undeliveredTurnFinished = null;
  emitProtocolV2Message(
    connection.writer,
    runtime,
    pending,
    {
      agent_id: runtime.agentId,
      conversation_id: runtime.conversationId,
    },
    toListenerConnection(connectionId),
  );
  evictConversationRuntimeIfIdle(runtime);
}
