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
  RuntimeStartResponseMessage,
  StreamDeltaMessage,
  WsProtocolMessage,
} from "@/types/app-server-protocol";
import type { QueueUpdateMessage } from "@/types/protocol_v2";
import type {
  ChannelGatewayClient,
  ChannelGatewayDelivery,
  ChannelGatewayHooks,
} from "./gateway-core";
import type {
  ChannelControlRequestEvent,
  ChannelTurnLifecycleEvent,
  ChannelTurnProgressEvent,
  ChannelTurnSource,
} from "./types";

// ── Fake client ──────────────────────────────────────────────────

export interface FakeClientOptions {
  startResponse?: Partial<RuntimeStartResponseMessage>;
  inputResponse?: Partial<InputAcceptedResponseMessage>;
  toolUpdateWait?: Promise<void>;
}

export class FakeClient implements ChannelGatewayClient {
  private messageListeners: Array<(message: WsProtocolMessage) => void> = [];
  private externalToolListeners: Array<
    (request: ExternalToolCallRequestMessage) => unknown
  > = [];
  readonly submittedInputs: Array<{
    runtime: RuntimeScope;
    payload: unknown;
  }> = [];
  readonly startedRuntimes: Array<{
    agent_id?: string;
    conversation_id?: string;
    conversation_source_tags?: readonly string[];
    mode?: string;
    preserve_skill_sources?: boolean;
    external_tools?: unknown;
  }> = [];
  readonly runtimeToolUpdates: Array<RuntimeExternalToolsUpdateGroup> = [];
  closeCalls = 0;
  // Mutable input response for per-test control
  inputResponse: { accepted: boolean; disposition: "started" | "queued" };

  constructor(private readonly options: FakeClientOptions = {}) {
    this.inputResponse = {
      accepted: options.inputResponse?.accepted ?? true,
      disposition: options.inputResponse?.disposition ?? "started",
    };
  }

  onMessage(listener: (message: WsProtocolMessage) => void): () => void {
    this.messageListeners.push(listener);
    return () => {
      const idx = this.messageListeners.indexOf(listener);
      if (idx >= 0) this.messageListeners.splice(idx, 1);
    };
  }

  onExternalToolCall(
    handler: (
      request: ExternalToolCallRequestMessage,
    ) => Promise<ExternalToolCallResult> | ExternalToolCallResult,
  ): () => void {
    this.externalToolListeners.push(handler);
    return () => {
      const idx = this.externalToolListeners.indexOf(handler);
      if (idx >= 0) this.externalToolListeners.splice(idx, 1);
    };
  }

  async submitInput(
    command: Omit<InputCommand, "type">,
  ): Promise<InputAcceptedResponseMessage> {
    this.submittedInputs.push({
      runtime: command.runtime,
      payload: command.payload,
    });
    return {
      type: "input_accepted",
      request_id: "test-req",
      runtime: command.runtime,
      accepted: this.inputResponse.accepted,
      disposition: this.inputResponse.disposition,
      ...(this.options.inputResponse?.error
        ? { error: this.options.inputResponse.error }
        : {}),
    };
  }

  async runtimeStart(
    opts: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
  ): Promise<RuntimeStartResponseMessage> {
    this.startedRuntimes.push(opts);
    return {
      type: "runtime_start_response",
      request_id: opts.request_id ?? "test-req",
      success: this.options.startResponse?.success ?? true,
      runtime: this.options.startResponse?.runtime ?? null,
      agent: this.options.startResponse?.agent ?? null,
      conversation: this.options.startResponse?.conversation ?? null,
      created: this.options.startResponse?.created ?? {
        agent: false,
        conversation: false,
      },
      ...(this.options.startResponse?.error
        ? { error: this.options.startResponse.error }
        : {}),
    };
  }

  async runtimeExternalToolsUpdate(options: {
    updates: readonly RuntimeExternalToolsUpdateGroup[];
  }): Promise<RuntimeExternalToolsUpdateResponseMessage> {
    this.runtimeToolUpdates.push(...options.updates);
    await this.options.toolUpdateWait;
    return {
      type: "runtime_external_tools_update_response",
      request_id: "runtime-external-tools-test",
      success: true,
    };
  }

  close(): void {
    this.closeCalls += 1;
  }

  // Test helpers
  emit(message: WsProtocolMessage): void {
    for (const listener of this.messageListeners) listener(message);
  }

  emitExternalToolCall(request: ExternalToolCallRequestMessage): void {
    for (const listener of this.externalToolListeners) listener(request);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

export const TEST_RUNTIME: RuntimeScope = {
  agent_id: "agent-1",
  conversation_id: "conv-1",
};

export function makeSource(
  overrides: Partial<ChannelTurnSource> = {},
): ChannelTurnSource {
  return {
    channel: "telegram",
    chatId: "chat-1",
    agentId: "agent-1",
    conversationId: "conv-1",
    ...overrides,
  };
}

export function makeDelivery(
  overrides: Partial<ChannelGatewayDelivery> = {},
): ChannelGatewayDelivery {
  return {
    runtime: TEST_RUNTIME,
    content: "Hello" as MessageCreate["content"],
    sources: [makeSource()],
    clientMessageId: "cm-test-1",
    ...overrides,
  };
}

export interface HookCollector {
  hooks: ChannelGatewayHooks;
  lifecycleEvents: ChannelTurnLifecycleEvent[];
  progressEvents: ChannelTurnProgressEvent[];
  controlRequestEvents: ChannelControlRequestEvent[];
  externalToolResults: ExternalToolCallResult[];
}

export function makeHooks(
  overrides: Partial<ChannelGatewayHooks> = {},
): HookCollector {
  const lifecycleEvents: ChannelTurnLifecycleEvent[] = [];
  const progressEvents: ChannelTurnProgressEvent[] = [];
  const controlRequestEvents: ChannelControlRequestEvent[] = [];
  const externalToolResults: ExternalToolCallResult[] = [];

  const hooks: ChannelGatewayHooks = {
    buildExternalTool: async () =>
      ({
        name: "MessageChannel",
        description: "Send a message through a channel",
        parameters: {},
      }) satisfies ExternalToolDefinitionPayload,
    executeExternalTool: async (_request) => {
      const result: ExternalToolCallResult = {
        content: [{ type: "text", text: "ok" }],
      };
      externalToolResults.push(result);
      return result;
    },
    onLifecycle: (event) => {
      lifecycleEvents.push(event);
    },
    onProgress: (event) => {
      progressEvents.push(event);
    },
    onControlRequest: (event) => {
      controlRequestEvents.push(event);
    },
    ...overrides,
  };

  return {
    hooks,
    lifecycleEvents,
    progressEvents,
    controlRequestEvents,
    externalToolResults,
  };
}

export function makeStreamDelta(
  delta: Record<string, unknown>,
  runtime: RuntimeScope = TEST_RUNTIME,
): StreamDeltaMessage {
  return {
    type: "stream_delta",
    runtime,
    event_seq: 0,
    emitted_at: new Date().toISOString(),
    idempotency_key: "key-1",
    delta: delta as unknown as StreamDeltaMessage["delta"],
  };
}

export function makeQueueUpdate(
  queue: Array<{ client_message_id: string }>,
  runtime: RuntimeScope = TEST_RUNTIME,
): QueueUpdateMessage {
  return {
    type: "update_queue",
    runtime,
    event_seq: 0,
    emitted_at: new Date().toISOString(),
    idempotency_key: "key-1",
    queue: queue as unknown as QueueUpdateMessage["queue"],
  };
}

export function makeTurnFinished(
  stopReason: string,
  runtime: RuntimeScope = TEST_RUNTIME,
  extra: { runId?: string; error?: string } = {},
): WsProtocolMessage {
  return {
    type: "turn_finished",
    runtime,
    event_seq: 0,
    emitted_at: new Date().toISOString(),
    idempotency_key: "key-1",
    turn_id: "turn-1",
    stop_reason: stopReason,
    ...(extra.runId ? { run_id: extra.runId } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  } as unknown as WsProtocolMessage;
}
