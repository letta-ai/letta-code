import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type {
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
  ExternalToolDefinitionPayload,
  InputAcceptedResponseMessage,
  InputCommand,
  RuntimeExternalToolsUpdateGroup,
  RuntimeExternalToolsUpdateResponseMessage,
  RuntimeScope,
  RuntimeStartCommand,
  RuntimeStartExternalToolsGroup,
  RuntimeStartResponseMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
import type { GatewayAssistantTextAccumulatorState } from "./gateway-assistant-relay";
import type {
  MessageChannelIdempotencyScope,
  MessageChannelIdempotencyState,
} from "./message-channel-idempotency";
import type {
  ChannelControlRequestEvent,
  ChannelDefaultPermissionMode,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
} from "./types";

export interface ChannelGatewayClient {
  close(): void;
  onMessage(listener: (message: WsProtocolMessage) => void): () => void;
  onExternalToolCall(
    handler: (
      request: ExternalToolCallRequestMessage,
    ) => Promise<ExternalToolCallResult> | ExternalToolCallResult,
  ): () => void;
  submitInput(
    command: Omit<InputCommand, "type">,
  ): Promise<InputAcceptedResponseMessage>;
  runtimeStart(
    options: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage>;
  runtimeExternalToolsUpdate(options: {
    updates: readonly RuntimeExternalToolsUpdateGroup[];
  }): Promise<RuntimeExternalToolsUpdateResponseMessage>;
}

export interface ChannelGatewayHooks {
  buildExternalTool(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[],
    policy?: { automaticRelay: boolean },
  ): Promise<ExternalToolDefinitionPayload | null>;
  resolveAssistantRelayPolicy?(
    runtime: RuntimeScope,
    sources: ChannelTurnSource[],
  ): boolean | Promise<boolean>;
  executeExternalTool(
    request: ExternalToolCallRequestMessage,
    sources: ChannelTurnSource[],
    idempotencyScope?: MessageChannelIdempotencyScope | null,
  ): Promise<ExternalToolCallResult> | ExternalToolCallResult;
  relayAssistantText?(options: {
    text: string;
    sources: ChannelTurnSource[];
    idempotencyScope: MessageChannelIdempotencyScope;
  }): void | Promise<void>;
  onLifecycle(event: ChannelTurnLifecycleEvent): void | Promise<void>;
  onProgress(event: ChannelTurnProgressEvent): void | Promise<void>;
  onControlRequest(event: ChannelControlRequestEvent): void | Promise<void>;
  createRichDraft?(options: {
    batchId: string;
    sources: ChannelTurnSource[];
  }): ChannelGatewayRichDraft | null;
}

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
  /** Effective policy captured when this turn was registered. */
  automaticRelay?: boolean;
  /** Immutable scoped tool registrations retained across ownership handoff. */
  toolScopes?: ChannelGatewayToolScopeState[];
}

export interface ChannelGatewayToolScopeState {
  id: string;
  runtime: RuntimeScope;
  sources: ChannelTurnSource[];
  automaticRelay: boolean;
  group?: RuntimeStartExternalToolsGroup;
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
