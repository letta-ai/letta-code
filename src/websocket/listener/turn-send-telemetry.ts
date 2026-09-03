import { hashTelemetryCorrelationId, telemetry } from "@/telemetry";
import { getInboundClientMessageIds } from "./inbound-queue";
import type { IncomingMessage } from "./types";

export type ListenerInputSendTimings = {
  prepareListenerTurnMs: number;
  skillContentInjectionMs: number;
  coreStreamRequestMs: number;
};

export function elapsedTelemetryMsSince(start: number): number {
  return Math.round((performance.now() - start) * 100) / 100;
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createListenerInputSendTelemetry(params: {
  msg: IncomingMessage;
  connectionId?: string;
  agentId: string | null;
  conversationId: string;
}): {
  timings: ListenerInputSendTimings;
  track: (success: boolean, error?: unknown) => void;
} {
  const acceptedAtMs =
    params.msg.telemetryInputAcceptedAtMs ?? performance.now();
  const clientMessageIds = getInboundClientMessageIds(params.msg);
  const timings: ListenerInputSendTimings = {
    prepareListenerTurnMs: 0,
    skillContentInjectionMs: 0,
    coreStreamRequestMs: 0,
  };
  let tracked = false;

  return {
    timings,
    track(success, error) {
      if (tracked) return;
      tracked = true;
      telemetry.trackListenerInputSendComplete({
        ...(params.connectionId
          ? {
              connection_id_hash: hashTelemetryCorrelationId(
                params.connectionId,
              ),
            }
          : {}),
        agent_id: params.agentId,
        conversation_id: params.conversationId,
        ...(clientMessageIds[0]
          ? {
              client_message_id_hash: hashTelemetryCorrelationId(
                clientMessageIds[0],
              ),
            }
          : {}),
        client_message_count: clientMessageIds.length,
        message_count: params.msg.messages.length,
        includes_approval: params.msg.messages.some(
          (message) => "type" in message && message.type === "approval",
        ),
        success,
        accepted_to_core_stream_ms: elapsedTelemetryMsSince(acceptedAtMs),
        prepare_listener_turn_ms: timings.prepareListenerTurnMs,
        skill_content_injection_ms: timings.skillContentInjectionMs,
        core_stream_request_ms: timings.coreStreamRequestMs,
        ...(error ? { error_type: errorType(error) } : {}),
      });
    },
  };
}
