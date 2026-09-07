import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { RuntimeScope } from "@/types/app-server-protocol";
import type { GatewayAssistantTextAccumulatorState } from "./gateway-assistant-relay";
import type { MessageChannelIdempotencyState } from "./message-channel-idempotency";
import type { ChannelDefaultPermissionMode, ChannelTurnSource } from "./types";

export interface ChannelGatewayDelivery {
  runtime: RuntimeScope;
  content: MessageCreate["content"];
  sources: ChannelTurnSource[];
  clientMessageId: string;
  defaultPermissionMode?: ChannelDefaultPermissionMode;
}

export interface ChannelGatewayActiveTurnState {
  assistantText: GatewayAssistantTextAccumulatorState;
  idempotency: MessageChannelIdempotencyState;
}

export type ChannelGatewayHandoffDelivery = Omit<
  ChannelGatewayDelivery,
  "content"
> & {
  activeTurnState?: ChannelGatewayActiveTurnState;
};

export interface ChannelGatewayRichDraft {
  handleDelta(
    delta: import("@/types/app-server-protocol").StreamDeltaMessage["delta"],
  ): void;
  flushPending(): Promise<void>;
  dispose(): void;
}

export interface ChannelGatewayModelStatus {
  modelHandle: string | null;
  scope: "agent" | "conversation";
}
