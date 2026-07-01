import type {
  AbortMessageCommand,
  AbortMessageResponseMessage,
  ConversationListCommand,
  ConversationListResponseMessage,
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
  InputCommand,
  LoopStatusUpdateMessage,
  RuntimeScope,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  StreamDeltaMessage,
  SyncCommand,
  SyncResponseMessage,
  WsProtocolCommand,
  WsProtocolMessage,
} from "./types/app-server-protocol";

export type AppServerChannel = "control" | "stream";

/**
 * Receives every parsed protocol frame from both app-server websocket channels.
 * Treat this as the primary event stream: app-server may emit replay or turn
 * updates on the same channel that sent the triggering command, not only on the
 * stream channel. The channel argument is diagnostic/routing context.
 */
export type AppServerMessageHandler = (
  message: WsProtocolMessage,
  channel: AppServerChannel,
) => void;

/** Called synchronously before a protocol command is written to the control socket. */
export type AppServerSendHandler = (command: WsProtocolCommand) => void;

export type AppServerExternalToolCallHandler = (
  request: ExternalToolCallRequestMessage,
) => Promise<ExternalToolCallResult> | ExternalToolCallResult;

export interface AppServerSocketLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (event: unknown) => void): void;
  removeEventListener?(type: string, listener: (event: unknown) => void): void;
  on?(type: string, listener: (event: unknown) => void): void;
  off?(type: string, listener: (event: unknown) => void): void;
  once?(type: string, listener: (event: unknown) => void): void;
}

export interface AppServerSocketOptions {
  headers?: Record<string, string>;
}

export type AppServerSocketConstructor = new (
  url: string,
  options?: AppServerSocketOptions,
) => AppServerSocketLike;

export interface AppServerClientOptions {
  /** Base app-server URL, e.g. ws://127.0.0.1:4500 or http://127.0.0.1:4500. */
  url: string;
  /** Optional capability token sent as Authorization: Bearer <token>; requires a WebSocket implementation with header support. */
  authToken?: string;
  /** Optional WebSocket constructor for Node/tests. Browsers use globalThis.WebSocket. */
  WebSocket?: AppServerSocketConstructor;
  /** Default timeout for request_id-correlated control requests. */
  requestTimeoutMs?: number;
}

export interface AppServerRequestOptions<TMessage extends WsProtocolMessage> {
  timeoutMs?: number;
  predicate?: (message: WsProtocolMessage) => message is TMessage;
}

export type AppServerRequestCommand = Extract<
  WsProtocolCommand,
  { request_id?: string }
>;

export type AppServerRequestCommandWithId = AppServerRequestCommand & {
  request_id: string;
};

export type AppServerRequestBody = Record<string, unknown> & {
  request_id?: string;
};

type PendingRequest = {
  resolve: (message: WsProtocolMessage) => void;
  reject: (error: Error) => void;
  predicate?: (message: WsProtocolMessage) => boolean;
  timeout: ReturnType<typeof setTimeout>;
};

export type AppServerTurnCompletionSource =
  | "stop_reason"
  | "loop_status_waiting_on_approval"
  | "loop_status_waiting_fallback";

export interface AppServerTurnResult {
  runtime: RuntimeScope;
  stopReason: string | null;
  runIds: string[];
  clientMessageIds: string[];
  completedBy: AppServerTurnCompletionSource;
  terminalMessage: WsProtocolMessage;
}

export interface AppServerRunTurnOptions {
  timeoutMs?: number;
  /**
   * Prefer explicit stream terminal events. This fallback is only used after
   * the client has seen stream/run evidence for this runtime, never from idle
   * loop status alone.
   */
  allowLoopStatusFallback?: boolean;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const WEBSOCKET_OPEN_STATE = 1;

function getGlobalWebSocket(): AppServerSocketConstructor | undefined {
  return (globalThis as { WebSocket?: AppServerSocketConstructor }).WebSocket;
}

function normalizeBaseUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") parsed.protocol = "ws:";
  if (parsed.protocol === "https:") parsed.protocol = "wss:";
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`Unsupported app-server URL protocol: ${parsed.protocol}`);
  }
  if (!parsed.pathname || parsed.pathname === "/") {
    parsed.pathname = "/ws";
  }
  return parsed;
}

export function resolveAppServerChannelUrl(
  url: string,
  channel: AppServerChannel,
): string {
  const parsed = normalizeBaseUrl(url);
  parsed.searchParams.set("channel", channel);
  return parsed.toString();
}

function attachSocketListener(
  socket: AppServerSocketLike,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.addEventListener && socket.removeEventListener) {
    socket.addEventListener(type, listener);
    return () => socket.removeEventListener?.(type, listener);
  }

  if (socket.on) {
    socket.on(type, listener);
    return () => socket.off?.(type, listener);
  }

  throw new Error("WebSocket implementation does not support event listeners");
}

function onceSocketEvent(
  socket: AppServerSocketLike,
  type: string,
  listener: (event: unknown) => void,
): () => void {
  if (socket.once) {
    socket.once(type, listener);
    return () => socket.off?.(type, listener);
  }

  let detach = () => {};
  detach = attachSocketListener(socket, type, (event) => {
    detach();
    listener(event);
  });
  return detach;
}

function waitForSocketOpen(socket: AppServerSocketLike): Promise<void> {
  if (socket.readyState === WEBSOCKET_OPEN_STATE) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let detachOpen = () => {};
    let detachError = () => {};
    const cleanup = () => {
      detachOpen();
      detachError();
    };
    detachOpen = onceSocketEvent(socket, "open", () => {
      cleanup();
      resolve();
    });
    detachError = onceSocketEvent(socket, "error", (event) => {
      cleanup();
      reject(
        new Error(`App-server WebSocket failed to open: ${String(event)}`),
      );
    });
  });
}

function rawEventData(event: unknown): unknown {
  if (event && typeof event === "object" && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function messageDataToString(data: unknown): string {
  const raw = rawEventData(data);
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) {
    return new TextDecoder().decode(raw);
  }
  if (raw instanceof Uint8Array) {
    return new TextDecoder().decode(raw);
  }
  if (ArrayBuffer.isView(raw)) {
    return new TextDecoder().decode(
      new Uint8Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength),
    );
  }
  return String(raw);
}

function parseProtocolMessage(event: unknown): WsProtocolMessage {
  return JSON.parse(messageDataToString(event)) as WsProtocolMessage;
}

function appServerSocketOptions(
  authToken: string | undefined,
): AppServerSocketOptions | undefined {
  if (authToken === undefined) {
    return undefined;
  }
  const token = authToken.trim();
  if (!token) {
    throw new Error("app-server auth token must not be empty");
  }
  return { headers: { Authorization: `Bearer ${token}` } };
}

function sameRuntime(a: RuntimeScope | undefined, b: RuntimeScope): boolean {
  return a?.agent_id === b.agent_id && a?.conversation_id === b.conversation_id;
}

function isWaitingLoopStatus(message: LoopStatusUpdateMessage): boolean {
  return message.loop_status.status === "WAITING_ON_INPUT";
}

function isWaitingOnApprovalLoopStatus(
  message: LoopStatusUpdateMessage,
): boolean {
  return message.loop_status.status === "WAITING_ON_APPROVAL";
}

function streamDeltaRunId(message: StreamDeltaMessage): string | null {
  const runId = (message.delta as { run_id?: unknown }).run_id;
  return typeof runId === "string" ? runId : null;
}

function streamDeltaMessageType(message: StreamDeltaMessage): string | null {
  const messageType = (message.delta as { message_type?: unknown })
    .message_type;
  return typeof messageType === "string" ? messageType : null;
}

function streamDeltaStopReason(message: StreamDeltaMessage): string | null {
  const stopReason = (message.delta as { stop_reason?: unknown }).stop_reason;
  return typeof stopReason === "string" ? stopReason : null;
}

function streamDeltaErrorMessage(message: StreamDeltaMessage): string {
  const delta = message.delta as {
    message?: unknown;
    api_error?: { message?: unknown; detail?: unknown };
  };
  const apiMessage = delta.api_error?.message ?? delta.api_error?.detail;
  if (typeof apiMessage === "string" && apiMessage.length > 0)
    return apiMessage;
  if (typeof delta.message === "string" && delta.message.length > 0)
    return delta.message;
  return "App-server turn failed";
}

export class AppServerClient {
  readonly control: AppServerSocketLike;
  readonly stream: AppServerSocketLike;

  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly sendHandlers = new Set<AppServerSendHandler>();
  private readonly activeTurnRuntimes = new Set<string>();
  private nextRequestNumber = 0;

  constructor(options: AppServerClientOptions) {
    const WebSocket = options.WebSocket ?? getGlobalWebSocket();
    if (!WebSocket) {
      throw new Error("No WebSocket implementation available");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const socketOptions = appServerSocketOptions(options.authToken);
    this.control = new WebSocket(
      resolveAppServerChannelUrl(options.url, "control"),
      socketOptions,
    );
    this.stream = new WebSocket(
      resolveAppServerChannelUrl(options.url, "stream"),
      socketOptions,
    );

    attachSocketListener(this.control, "message", (event) => {
      this.handleMessage(event, "control");
    });
    attachSocketListener(this.stream, "message", (event) => {
      this.handleMessage(event, "stream");
    });
    const rejectPending = () =>
      this.rejectAllPending("App-server socket closed");
    attachSocketListener(this.control, "close", rejectPending);
    attachSocketListener(this.stream, "close", rejectPending);
  }

  async connect(): Promise<this> {
    await Promise.all([
      waitForSocketOpen(this.control),
      waitForSocketOpen(this.stream),
    ]);
    return this;
  }

  close(): void {
    this.rejectAllPending("App-server client closed");
    this.control.close();
    this.stream.close();
  }

  onMessage(handler: AppServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onSend(handler: AppServerSendHandler): () => void {
    this.sendHandlers.add(handler);
    return () => this.sendHandlers.delete(handler);
  }

  nextRequestId(prefix = "req"): string {
    this.nextRequestNumber += 1;
    return `${prefix}-${this.nextRequestNumber}`;
  }

  send(command: WsProtocolCommand): void {
    for (const handler of this.sendHandlers) {
      handler(command);
    }
    this.control.send(JSON.stringify(command));
  }

  request<TMessage extends WsProtocolMessage = WsProtocolMessage>(
    command: AppServerRequestCommandWithId,
    options?: AppServerRequestOptions<TMessage>,
  ): Promise<TMessage>;

  request<
    TType extends AppServerRequestCommand["type"],
    TMessage extends WsProtocolMessage = WsProtocolMessage,
  >(
    type: TType,
    body?: AppServerRequestBody,
    options?: AppServerRequestOptions<TMessage>,
  ): Promise<TMessage>;

  request<TMessage extends WsProtocolMessage = WsProtocolMessage>(
    commandOrType:
      | AppServerRequestCommandWithId
      | AppServerRequestCommand["type"],
    bodyOrOptions:
      | AppServerRequestBody
      | AppServerRequestOptions<TMessage> = {},
    maybeOptions: AppServerRequestOptions<TMessage> = {},
  ): Promise<TMessage> {
    const isTypeRequest = typeof commandOrType === "string";
    const command = isTypeRequest
      ? ({
          type: commandOrType,
          request_id:
            (bodyOrOptions as { request_id?: string }).request_id ??
            this.nextRequestId(commandOrType),
          ...(bodyOrOptions as object),
        } as AppServerRequestCommandWithId)
      : commandOrType;
    const options = isTypeRequest
      ? maybeOptions
      : (bodyOrOptions as AppServerRequestOptions<TMessage>);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new Error(`Timed out waiting for ${command.request_id}`));
      }, timeoutMs);

      this.pending.set(command.request_id, {
        resolve: (message) => resolve(message as TMessage),
        reject,
        predicate: options.predicate,
        timeout,
      });

      try {
        this.send(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  runtimeStart(
    command: Omit<RuntimeStartCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<RuntimeStartResponseMessage>,
      "predicate"
    > = {},
  ): Promise<RuntimeStartResponseMessage> {
    return this.request(
      {
        type: "runtime_start",
        request_id: command.request_id ?? this.nextRequestId("runtime-start"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is RuntimeStartResponseMessage =>
          message.type === "runtime_start_response",
      },
    );
  }

  sync(
    command: Omit<SyncCommand, "type" | "request_id"> & { request_id?: string },
    options: Omit<
      AppServerRequestOptions<SyncResponseMessage>,
      "predicate"
    > = {},
  ): Promise<SyncResponseMessage> {
    return this.request(
      {
        type: "sync",
        request_id: command.request_id ?? this.nextRequestId("sync"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is SyncResponseMessage =>
          message.type === "sync_response",
      },
    );
  }

  abort(
    command: Omit<AbortMessageCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<AbortMessageResponseMessage>,
      "predicate"
    > = {},
  ): Promise<AbortMessageResponseMessage> {
    return this.request(
      {
        type: "abort_message",
        request_id: command.request_id ?? this.nextRequestId("abort"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is AbortMessageResponseMessage =>
          message.type === "abort_message_response",
      },
    );
  }

  conversationList(
    command: Omit<ConversationListCommand, "type" | "request_id"> & {
      request_id?: string;
    } = {},
    options: Omit<
      AppServerRequestOptions<ConversationListResponseMessage>,
      "predicate"
    > = {},
  ): Promise<ConversationListResponseMessage> {
    return this.request(
      {
        type: "conversation_list",
        request_id:
          command.request_id ?? this.nextRequestId("conversation-list"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is ConversationListResponseMessage =>
          message.type === "conversation_list_response",
      },
    );
  }

  onExternalToolCall(handler: AppServerExternalToolCallHandler): () => void {
    return this.onMessage((message, channel) => {
      if (
        channel !== "control" ||
        message.type !== "external_tool_call_request"
      ) {
        return;
      }

      void Promise.resolve(handler(message))
        .then((result) => {
          this.send({
            type: "external_tool_call_response",
            request_id: message.request_id,
            result,
          });
        })
        .catch((error) => {
          this.send({
            type: "external_tool_call_response",
            request_id: message.request_id,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    });
  }

  input(command: Omit<InputCommand, "type">): void {
    this.send({ type: "input", ...command });
  }

  runTurn(
    command: Omit<InputCommand, "type">,
    options: AppServerRunTurnOptions = {},
  ): Promise<AppServerTurnResult> {
    const runtimeKey = `${command.runtime.agent_id}/${command.runtime.conversation_id}`;
    if (this.activeTurnRuntimes.has(runtimeKey)) {
      return Promise.reject(
        new Error(`A turn is already in flight for ${runtimeKey}`),
      );
    }
    this.activeTurnRuntimes.add(runtimeKey);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    const commandWithIds = this.withClientMessageIds(command);
    const runIds = new Set<string>();
    let observedTurnEvidence = false;
    let observedRequiresApprovalStop = false;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out waiting for app-server turn on ${command.runtime.agent_id}/${command.runtime.conversation_id}`,
          ),
        );
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        this.activeTurnRuntimes.delete(runtimeKey);
        offMessage();
      };

      const finish = (
        completedBy: AppServerTurnCompletionSource,
        terminalMessage: WsProtocolMessage,
        stopReason: string | null,
      ) => {
        cleanup();
        resolve({
          runtime: command.runtime,
          stopReason,
          runIds: [...runIds],
          clientMessageIds: commandWithIds.clientMessageIds,
          completedBy,
          terminalMessage,
        });
      };

      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };

      const offMessage = this.onMessage((message) => {
        if (
          !sameRuntime(
            (message as { runtime?: RuntimeScope }).runtime,
            command.runtime,
          )
        ) {
          return;
        }

        if (message.type === "stream_delta") {
          observedTurnEvidence = true;
          const runId = streamDeltaRunId(message);
          if (runId) runIds.add(runId);

          const messageType = streamDeltaMessageType(message);
          if (messageType === "loop_error" || messageType === "error_message") {
            fail(new Error(streamDeltaErrorMessage(message)));
            return;
          }
          if (messageType === "stop_reason") {
            const stopReason = streamDeltaStopReason(message);
            if (stopReason === "requires_approval") {
              observedRequiresApprovalStop = true;
              return;
            }
            finish("stop_reason", message, stopReason);
          }
          return;
        }

        if (message.type === "update_loop_status") {
          const hadTurnEvidenceBeforeLoopStatus =
            observedTurnEvidence || observedRequiresApprovalStop;
          if (
            !hadTurnEvidenceBeforeLoopStatus &&
            (isWaitingOnApprovalLoopStatus(message) ||
              (options.allowLoopStatusFallback === true &&
                isWaitingLoopStatus(message)))
          ) {
            return;
          }
          for (const runId of message.loop_status.active_run_ids) {
            observedTurnEvidence = true;
            runIds.add(runId);
          }
          if (
            hadTurnEvidenceBeforeLoopStatus &&
            isWaitingOnApprovalLoopStatus(message)
          ) {
            finish(
              "loop_status_waiting_on_approval",
              message,
              "requires_approval",
            );
            return;
          }
          if (
            options.allowLoopStatusFallback === true &&
            hadTurnEvidenceBeforeLoopStatus &&
            isWaitingLoopStatus(message)
          ) {
            finish("loop_status_waiting_fallback", message, null);
          }
        }
      });

      try {
        this.input(commandWithIds.command);
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private withClientMessageIds(command: Omit<InputCommand, "type">): {
    command: Omit<InputCommand, "type">;
    clientMessageIds: string[];
  } {
    if (command.payload.kind !== "create_message") {
      return { command, clientMessageIds: [] };
    }

    const clientMessageIds: string[] = [];
    const messages = command.payload.messages.map((message) => {
      if (message.role !== "user") return message;
      const existing = (message as { client_message_id?: unknown })
        .client_message_id;
      const clientMessageId =
        typeof existing === "string" && existing.length > 0
          ? existing
          : this.nextRequestId("client-message");
      clientMessageIds.push(clientMessageId);
      return { ...message, client_message_id: clientMessageId };
    });

    return {
      command: {
        ...command,
        payload: { ...command.payload, messages },
      },
      clientMessageIds,
    };
  }

  private handleMessage(event: unknown, channel: AppServerChannel): void {
    const message = parseProtocolMessage(event);

    for (const handler of this.messageHandlers) {
      handler(message, channel);
    }

    const requestId =
      message && typeof message === "object" && "request_id" in message
        ? (message as { request_id?: unknown }).request_id
        : undefined;
    if (channel !== "control" || typeof requestId !== "string") {
      return;
    }

    const pending = this.pending.get(requestId);
    if (!pending || (pending.predicate && !pending.predicate(message))) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(message);
  }

  private rejectAllPending(reason: string): void {
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timeout);
      this.pending.delete(requestId);
      pending.reject(new Error(reason));
    }
  }
}

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  return new AppServerClient(options);
}
