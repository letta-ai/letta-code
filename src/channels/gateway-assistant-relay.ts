import type {
  StopReasonType,
  StreamDeltaMessage,
} from "@/types/app-server-protocol";
import type { MessageChannelIdempotencyScope } from "./message-channel-idempotency";
import type { ChannelTurnSource } from "./types";

export interface GatewayAssistantTextAccumulatorState {
  textByMessageId: Array<[string, string]>;
  deltaKeys: string[];
}

export class GatewayAssistantTextAccumulator {
  private readonly textByMessageId: Map<string, string>;
  private readonly deltaKeys: Set<string>;

  constructor(state?: GatewayAssistantTextAccumulatorState) {
    this.textByMessageId = new Map(state?.textByMessageId ?? []);
    this.deltaKeys = new Set(state?.deltaKeys ?? []);
  }

  snapshot(): GatewayAssistantTextAccumulatorState {
    return {
      textByMessageId: [...this.textByMessageId.entries()],
      deltaKeys: [...this.deltaKeys],
    };
  }

  append(message: StreamDeltaMessage): void {
    if (
      message.delta.message_type !== "assistant_message" ||
      this.deltaKeys.has(message.idempotency_key)
    ) {
      return;
    }
    const delta = message.delta;
    const messageId = delta.otid || delta.id;
    if (!messageId) return;
    const text =
      typeof delta.content === "string"
        ? delta.content
        : delta.content.map((part) => part.text ?? "").join("");
    if (!text) return;
    this.deltaKeys.add(message.idempotency_key);
    this.textByMessageId.set(
      messageId,
      `${this.textByMessageId.get(messageId) ?? ""}${text}`,
    );
  }

  combinedText(): string {
    return [...this.textByMessageId.values()]
      .map((text) => text.trim())
      .filter(Boolean)
      .join(" ");
  }
}

export function channelTurnOutcome(
  stopReason: StopReasonType,
): "completed" | "error" | "cancelled" {
  if (stopReason === "cancelled") return "cancelled";
  return stopReason === "end_turn" || stopReason === "tool_rule"
    ? "completed"
    : "error";
}

export function relayCompletedAssistantText(options: {
  stopReason: StopReasonType;
  accumulator: GatewayAssistantTextAccumulator;
  sources: ChannelTurnSource[];
  idempotencyScope: MessageChannelIdempotencyScope;
  relay?: (options: {
    text: string;
    sources: ChannelTurnSource[];
    idempotencyScope: MessageChannelIdempotencyScope;
  }) => void | Promise<void>;
}): void | Promise<void> {
  if (
    (options.stopReason !== "end_turn" && options.stopReason !== "tool_rule") ||
    options.sources.length !== 1
  ) {
    return;
  }
  const text = options.accumulator.combinedText();
  if (!text) return;
  if (!options.relay) return;
  const warn = (error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[channels] Automatic relay failed: ${detail}`);
  };
  try {
    const pending = options.relay({
      text,
      sources: options.sources,
      idempotencyScope: options.idempotencyScope,
    });
    if (pending) return pending.catch(warn);
  } catch (error) {
    warn(error);
  }
}
