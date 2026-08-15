import { isAppServerInfoResponseMessage } from "./types/app-server-info";

export type { AppServerInfoResponseMessage } from "./types/app-server-info";
export { isAppServerInfoResponseMessage } from "./types/app-server-info";

import type {
  AbortMessageCommand,
  AbortMessageResponseMessage,
  AppServerInfoResponseMessage,
  ConversationListCommand,
  ConversationListResponseMessage,
  ExternalToolCallRequestMessage,
  ExternalToolCallResult,
  InputAcceptedResponseMessage,
  InputCommand,
  RuntimeExternalToolsUpdateCommand,
  RuntimeExternalToolsUpdateResponseMessage,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
  SyncCommand,
  SyncResponseMessage,
  WsProtocolCommand,
  WsProtocolMessage,
} from "./types/app-server-protocol";

export type AppServerChannel = "control" | "stream";

export type AppServerRawCommand = Record<string, unknown> & {
  type: string;
  request_id?: string;
};

export type AppServerRawResponse = Record<string, unknown> & {
  type: string;
  request_id?: string;
};

export type AppServerSendCommand = WsProtocolCommand | AppServerRawCommand;

/** Receives every parsed protocol frame from the app-server WebSocket. */
export type AppServerMessageHandler = (
  message: WsProtocolMessage,
  channel: AppServerChannel,
) => void;

/** Called synchronously before a typed or raw command is written to the socket. */
export type AppServerSendHandler = (command: AppServerSendCommand) => void;

export interface AppServerDisconnectEvent {
  channel: AppServerChannel;
  event: unknown;
}

/** Called once when the WebSocket closes before client.close(). */
export type AppServerDisconnectHandler = (
  disconnect: AppServerDisconnectEvent,
) => void;

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

export interface AppServerRawRequestOptions<
  TResponse extends AppServerRawResponse,
> {
  timeoutMs?: number;
  predicate: (message: unknown) => message is TResponse;
}

type PendingRequest = {
  resolve: (message: WsProtocolMessage) => void;
  reject: (error: Error) => void;
  predicate?: (message: WsProtocolMessage) => boolean;
  timeout: ReturnType<typeof setTimeout>;
};

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

export function resolveAppServerUrl(url: string): string {
  const parsed = normalizeBaseUrl(url);
  parsed.searchParams.delete("channel");
  return parsed.toString();
}

/**
 * @deprecated App-server uses one bidirectional WebSocket. Both historical
 * channel names resolve to that same socket URL.
 */
export function resolveAppServerChannelUrl(
  url: string,
  _channel: AppServerChannel,
): string {
  return resolveAppServerUrl(url);
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

export class AppServerClient {
  readonly socket: AppServerSocketLike;
  /** @deprecated Alias for socket. */
  readonly control: AppServerSocketLike;
  /** @deprecated Alias for socket; no second stream connection is created. */
  readonly stream: AppServerSocketLike;

  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly sendHandlers = new Set<AppServerSendHandler>();
  private readonly disconnectHandlers = new Set<AppServerDisconnectHandler>();
  private explicitlyClosed = false;
  private disconnectNotified = false;
  private nextRequestNumber = 0;

  constructor(options: AppServerClientOptions) {
    const WebSocket = options.WebSocket ?? getGlobalWebSocket();
    if (!WebSocket) {
      throw new Error("No WebSocket implementation available");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const socketOptions = appServerSocketOptions(options.authToken);
    this.socket = new WebSocket(
      resolveAppServerUrl(options.url),
      socketOptions,
    );
    this.control = this.socket;
    this.stream = this.socket;

    attachSocketListener(this.socket, "message", (event) => {
      this.handleMessage(event, "control");
    });
    attachSocketListener(this.socket, "close", (event) => {
      this.handleDisconnect("control", event);
    });
  }

  async connect(): Promise<this> {
    await waitForSocketOpen(this.socket);
    return this;
  }

  close(): void {
    if (this.explicitlyClosed) return;
    this.explicitlyClosed = true;
    this.rejectAllPending("App-server client closed");
    this.socket.close();
  }

  onMessage(handler: AppServerMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  onSend(handler: AppServerSendHandler): () => void {
    this.sendHandlers.add(handler);
    return () => this.sendHandlers.delete(handler);
  }

  onDisconnect(handler: AppServerDisconnectHandler): () => void {
    this.disconnectHandlers.add(handler);
    return () => this.disconnectHandlers.delete(handler);
  }

  nextRequestId(prefix = "req"): string {
    this.nextRequestNumber += 1;
    return `${prefix}-${this.nextRequestNumber}`;
  }

  send(command: WsProtocolCommand): void {
    this.writeCommand(command);
  }

  private writeCommand(command: AppServerSendCommand): void {
    for (const handler of this.sendHandlers) {
      handler(command);
    }
    this.socket.send(JSON.stringify(command));
  }

  /**
   * Send a forward-compatible protocol command from a compatibility adapter.
   * Prefer the typed wrappers above this boundary for normal product code.
   */
  sendRaw(command: AppServerRawCommand): void {
    this.writeCommand(command);
  }

  /**
   * Request a forward-compatible response without mirroring the full protocol
   * union in a downstream compatibility adapter.
   */
  requestRaw<TResponse extends AppServerRawResponse>(
    command: AppServerRawCommand & { request_id: string },
    options: AppServerRawRequestOptions<TResponse>,
  ): Promise<TResponse> {
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(command.request_id);
        reject(new Error(`Timed out waiting for ${command.request_id}`));
      }, timeoutMs);

      this.pending.set(command.request_id, {
        resolve: (message) => resolve(message as unknown as TResponse),
        reject,
        predicate: options.predicate,
        timeout,
      });

      try {
        this.sendRaw(command);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(command.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
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

  info(
    options: Omit<
      AppServerRequestOptions<AppServerInfoResponseMessage>,
      "predicate"
    > = {},
  ): Promise<AppServerInfoResponseMessage> {
    return this.request(
      {
        type: "app_server_info",
        request_id: this.nextRequestId("app-server-info"),
      },
      {
        ...options,
        predicate: isAppServerInfoResponseMessage,
      },
    );
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

  runtimeExternalToolsUpdate(
    command: Omit<RuntimeExternalToolsUpdateCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<RuntimeExternalToolsUpdateResponseMessage>,
      "predicate"
    > = {},
  ): Promise<RuntimeExternalToolsUpdateResponseMessage> {
    return this.request(
      {
        type: "runtime_external_tools_update",
        request_id:
          command.request_id ?? this.nextRequestId("runtime-external-tools"),
        ...command,
      },
      {
        ...options,
        predicate: (
          message,
        ): message is RuntimeExternalToolsUpdateResponseMessage =>
          message.type === "runtime_external_tools_update_response",
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

  /**
   * Submit input to a runtime. Observe progress, tool activity, approvals, and
   * terminal lifecycle events through onMessage().
   */
  input(command: Omit<InputCommand, "type">): void {
    this.send({ type: "input", ...command });
  }

  /**
   * Submit an input and wait only until the listener accepts it into the
   * normal dispatch/queue path. This never waits for turn completion.
   */
  submitInput(
    command: Omit<InputCommand, "type" | "request_id"> & {
      request_id?: string;
    },
    options: Omit<
      AppServerRequestOptions<InputAcceptedResponseMessage>,
      "predicate"
    > = {},
  ): Promise<InputAcceptedResponseMessage> {
    return this.request(
      {
        type: "input",
        request_id: command.request_id ?? this.nextRequestId("input"),
        ...command,
      },
      {
        ...options,
        predicate: (message): message is InputAcceptedResponseMessage =>
          message.type === "input_accepted",
      },
    );
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

  private handleDisconnect(channel: AppServerChannel, event: unknown): void {
    this.rejectAllPending("App-server socket closed");
    if (this.explicitlyClosed || this.disconnectNotified) return;
    this.disconnectNotified = true;
    for (const handler of this.disconnectHandlers) {
      handler({ channel, event });
    }
  }
}

export function createAppServerClient(
  options: AppServerClientOptions,
): AppServerClient {
  return new AppServerClient(options);
}
