import type {
  StopReasonType,
  StreamDeltaMessage,
} from "@/types/app-server-protocol";
import type { MessageChannelIdempotencyScope } from "./message-channel-idempotency";
import type { ChannelTurnSource } from "./types";

export interface GatewayAssistantTextAccumulatorState {
  currentMessageId: string | null;
  currentText: string;
  deltaKeys: string[];
  finalizedMessageIds: string[];
}

export interface FinalizedGatewayAssistantMessage {
  messageId: string;
  text: string;
}

export class GatewayAssistantTextAccumulator {
  private currentMessageId: string | null;
  private currentText: string;
  private readonly deltaKeys: Set<string>;
  private readonly finalizedMessageIds: Set<string>;

  constructor(state?: GatewayAssistantTextAccumulatorState) {
    this.currentMessageId = state?.currentMessageId ?? null;
    this.currentText = state?.currentText ?? "";
    this.deltaKeys = new Set(state?.deltaKeys ?? []);
    this.finalizedMessageIds = new Set(state?.finalizedMessageIds ?? []);
  }

  snapshot(): GatewayAssistantTextAccumulatorState {
    return {
      currentMessageId: this.currentMessageId,
      currentText: this.currentText,
      deltaKeys: [...this.deltaKeys],
      finalizedMessageIds: [...this.finalizedMessageIds],
    };
  }

  handleDelta(message: StreamDeltaMessage): FinalizedGatewayAssistantMessage[] {
    const delta = message.delta;
    if (delta.message_type === "assistant_message") {
      const messageId = delta.otid || delta.id;
      if (!messageId || this.finalizedMessageIds.has(messageId)) return [];

      const finalized =
        this.currentMessageId && this.currentMessageId !== messageId
          ? this.finalizeCurrent()
          : null;
      if (!this.currentMessageId) this.currentMessageId = messageId;

      if (!this.deltaKeys.has(message.idempotency_key)) {
        const text =
          typeof delta.content === "string"
            ? delta.content
            : delta.content.map((part) => part.text ?? "").join("");
        this.deltaKeys.add(message.idempotency_key);
        this.currentText += text;
      }
      return finalized ? [finalized] : [];
    }

    if (
      delta.message_type === "tool_call_message" ||
      delta.message_type === "approval_request_message"
    ) {
      const finalized = this.finalizeCurrent();
      return finalized ? [finalized] : [];
    }
    if (delta.message_type === "reasoning_message") {
      const boundaryId = delta.otid || delta.id;
      if (
        this.currentMessageId &&
        (!boundaryId || boundaryId !== this.currentMessageId)
      ) {
        const finalized = this.finalizeCurrent();
        return finalized ? [finalized] : [];
      }
    }
    return [];
  }

  finalizeCurrent(): FinalizedGatewayAssistantMessage | null {
    const messageId = this.currentMessageId;
    if (!messageId) return null;
    const text = this.currentText.trim();
    this.currentMessageId = null;
    this.currentText = "";
    this.finalizedMessageIds.add(messageId);
    return text ? { messageId, text } : null;
  }
}

export function relayFinalizedAssistantMessage(options: {
  message: FinalizedGatewayAssistantMessage;
  sources: ChannelTurnSource[];
  idempotencyScope: MessageChannelIdempotencyScope;
  relay?: (options: {
    text: string;
    sources: ChannelTurnSource[];
    idempotencyScope: MessageChannelIdempotencyScope;
  }) => void | Promise<void>;
}): void | Promise<void> {
  if (options.sources.length !== 1 || !options.relay) return;
  const warn = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[channels] Automatic relay failed: ${detail}`);
  };
  try {
    const pending = options.relay({
      text: options.message.text,
      sources: options.sources,
      idempotencyScope: options.idempotencyScope,
    });
    if (pending) return pending.catch(warn);
  } catch (error) {
    warn(error);
  }
}

export function stopReasonFromDelta(
  message: StreamDeltaMessage,
): StopReasonType | null {
  const delta = message.delta;
  return delta.message_type === "stop_reason" &&
    "stop_reason" in delta &&
    typeof delta.stop_reason === "string"
    ? delta.stop_reason
    : null;
}

export function runIdFromDelta(
  message: StreamDeltaMessage,
): string | undefined {
  const runId = "run_id" in message.delta ? message.delta.run_id : undefined;
  return typeof runId === "string" && runId.length > 0 ? runId : undefined;
}

export function channelTurnOutcome(
  stopReason: StopReasonType,
): "completed" | "error" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  return stopReason === "end_turn" || stopReason === "tool_rule"
    ? "completed"
    : "error";
}
