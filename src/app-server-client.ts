import type {
  AbortMessageCommand,
  AbortMessageResponseMessage,
  InputCommand,
  RuntimeStartCommand,
  RuntimeStartResponseMessage,
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

export type AppServerSocketConstructor = new (
  url: string,
) => AppServerSocketLike;

export interface AppServerClientOptions {
  /** Base app-server URL, e.g. ws://127.0.0.1:4500 or http://127.0.0.1:4500. */
  url: string;
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

export class AppServerClient {
  readonly control: AppServerSocketLike;
  readonly stream: AppServerSocketLike;

  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly messageHandlers = new Set<AppServerMessageHandler>();
  private readonly sendHandlers = new Set<AppServerSendHandler>();
  private nextRequestNumber = 0;

  constructor(options: AppServerClientOptions) {
    const WebSocket = options.WebSocket ?? getGlobalWebSocket();
    if (!WebSocket) {
      throw new Error("No WebSocket implementation available");
    }

    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.control = new WebSocket(
      resolveAppServerChannelUrl(options.url, "control"),
    );
    this.stream = new WebSocket(
      resolveAppServerChannelUrl(options.url, "stream"),
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

  input(command: Omit<InputCommand, "type">): void {
    this.send({ type: "input", ...command });
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
