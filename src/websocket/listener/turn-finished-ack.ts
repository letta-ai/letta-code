import { getOrCreateScopedRuntime } from "./conversation-runtime";
import type { ListenerTransport } from "./transport";
import {
  acknowledgeTurnFinished,
  replayPendingTurnFinishedToConnection,
} from "./turn-finished-replay";
import type { ListenerRuntime } from "./types";

export function handleTurnFinishedAck(
  runtime: ListenerRuntime,
  socket: ListenerTransport,
  connectionId: string,
  parsed: {
    runtime: { agent_id: string | null; conversation_id: string };
    idempotency_key: string;
    consumer_id: string;
  },
  dependencies: Partial<{
    acknowledge: typeof acknowledgeTurnFinished;
    replay: typeof replayPendingTurnFinishedToConnection;
  }> = {},
): void {
  const acknowledged = (dependencies.acknowledge ?? acknowledgeTurnFinished)({
    agentId: parsed.runtime.agent_id,
    conversationId: parsed.runtime.conversation_id,
    connectionId,
    idempotencyKey: parsed.idempotency_key,
    consumerId: parsed.consumer_id,
  });
  if (!acknowledged || !runtime.promotePreparedInputTerminals?.()) return;
  (dependencies.replay ?? replayPendingTurnFinishedToConnection)(
    socket,
    getOrCreateScopedRuntime(
      runtime,
      parsed.runtime.agent_id,
      parsed.runtime.conversation_id,
    ),
    connectionId,
  );
}
