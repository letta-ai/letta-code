import { randomUUID } from "node:crypto";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { SignalMessageTarget } from "./target";
import {
  normalizeSignalBaseUrl,
  signalTargetToReactionRpcParams,
  signalTargetToSendRpcParams,
} from "./target";

export type SignalSseEvent = {
  event?: string;
  data?: string;
  id?: string;
  retry?: string;
};

export type SignalClientOptions = {
  baseUrl: string;
  account?: string;
  requestTimeoutMs?: number;
};

export type SignalSendMessageParams = {
  target: SignalMessageTarget;
  message: string;
  attachments?: string[];
  textStyle?: string[];
};

export type SignalReactionParams = {
  target: SignalMessageTarget;
  emoji: string;
  targetTimestamp: number;
  targetAuthor: string;
  remove?: boolean;
};

export type SignalTypingParams = {
  target: SignalMessageTarget;
  stop?: boolean;
};

export class SignalRpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number | string,
    public readonly data?: unknown,
    public readonly method?: string,
    public readonly params?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SignalRpcError";
  }
}

function getRequest(url: URL) {
  return url.protocol === "https:" ? httpsRequest : httpRequest;
}

function createRequestOptions(url: URL, method: string): RequestOptions {
  return {
    method,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    path: `${url.pathname}${url.search}`,
  };
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSignalClientError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }
  return String(error);
}

function previewSignalEventData(event: SignalSseEvent): string {
  const data = event.data ?? "";
  if (!data) {
    return "<empty>";
  }
  return `<${Buffer.byteLength(data, "utf8")} bytes>`;
}

function previewSignalRpcParams(params: Record<string, unknown>): string {
  const safeParams = { ...params };
  for (const key of ["message", "captcha", "password", "token"]) {
    if (typeof safeParams[key] === "string") {
      safeParams[key] = `<${key}: ${String(safeParams[key]).length} chars>`;
    }
  }
  return JSON.stringify(safeParams);
}

function readResponseBody(
  response: IncomingMessage,
  maxBytes: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        response.destroy(new Error("Signal response exceeded size limit."));
        return;
      }
      body += chunk;
    });
    response.on("end", () => resolve(body));
    response.on("error", reject);
  });
}

export class SignalRestClient {
  private readonly baseUrl: string;
  private readonly account?: string;
  private readonly requestTimeoutMs: number;

  constructor(options: SignalClientOptions) {
    const baseUrl = normalizeSignalBaseUrl(options.baseUrl);
    if (!baseUrl) {
      throw new Error("Signal base URL is required.");
    }
    this.baseUrl = baseUrl;
    this.account = options.account?.trim() || undefined;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async check(): Promise<void> {
    let response: unknown;
    try {
      response = await this.request("GET", "/api/v1/check");
    } catch (checkError) {
      const fallback = await this.request("POST", "/api/v1/rpc", {
        jsonrpc: "2.0",
        method: "version",
        params: {},
        id: randomUUID(),
      }).catch((versionError: unknown) => {
        throw new Error(
          `Signal daemon health check failed: ${formatSignalClientError(checkError)}; version fallback failed: ${formatSignalClientError(versionError)}`,
        );
      });
      if (isRecord(fallback) && isRecord(fallback.error)) {
        throw new Error(
          `Signal daemon health check failed: ${formatSignalClientError(checkError)}; version fallback returned error: ${JSON.stringify(fallback.error)}`,
        );
      }
      return;
    }
    const status = isRecord(response) ? response.status : undefined;
    if (typeof status === "string" && status.toLowerCase() === "error") {
      throw new Error("Signal daemon health check returned error status.");
    }
  }

  async rpc<T = unknown>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const body = {
      jsonrpc: "2.0",
      method,
      params: this.withAccount(params),
      id: randomUUID(),
    };
    const response = await this.request("POST", "/api/v1/rpc", body);
    if (response === null) {
      return undefined as T;
    }
    if (!isRecord(response)) {
      throw new Error("Signal JSON-RPC response was not an object.");
    }
    if (isRecord(response.error)) {
      const message =
        typeof response.error.message === "string"
          ? response.error.message
          : `Signal RPC ${method} failed.`;
      const paramsPreview = previewSignalRpcParams(body.params);
      const code = response.error.code as number | string | undefined;
      const data = response.error.data;
      const dataPreview =
        data === undefined ? "undefined" : JSON.stringify(data);
      throw new SignalRpcError(
        `Signal RPC ${method} failed: ${message}; code=${code ?? "unknown"}; data=${dataPreview}; params=${paramsPreview}`,
        code,
        data,
        method,
        body.params,
      );
    }
    return response.result as T;
  }

  async sendMessage(params: SignalSendMessageParams): Promise<string> {
    const result = await this.rpc<unknown>("send", {
      message: params.message,
      ...signalTargetToSendRpcParams(params.target),
      ...(params.attachments && params.attachments.length > 0
        ? { attachments: params.attachments }
        : {}),
      ...(params.textStyle && params.textStyle.length > 0
        ? { textStyle: params.textStyle }
        : {}),
    });
    if (typeof result === "number" || typeof result === "string") {
      return String(result);
    }
    if (isRecord(result)) {
      const timestamp = result.timestamp ?? result.messageId ?? result.id;
      if (typeof timestamp === "number" || typeof timestamp === "string") {
        return String(timestamp);
      }
    }
    return "unknown";
  }

  async sendReaction(params: SignalReactionParams): Promise<void> {
    await this.rpc("sendReaction", {
      emoji: params.emoji,
      targetTimestamp: params.targetTimestamp,
      targetAuthor: params.targetAuthor,
      remove: params.remove === true,
      ...signalTargetToReactionRpcParams(params.target),
    });
  }

  async sendTyping(params: SignalTypingParams): Promise<void> {
    await this.rpc("sendTyping", {
      stop: params.stop === true,
      ...signalTargetToSendRpcParams(params.target),
    });
  }

  async streamEvents(
    onEvent: (event: SignalSseEvent) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    const url = new URL(`${this.baseUrl}/api/v1/events`);
    if (this.account) {
      url.searchParams.set("account", this.account);
    }

    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        resolve();
        return;
      }

      let settled = false;
      let buffer = "";
      let activeEvent: SignalSseEvent = {};
      let pendingEvents: Promise<void> = Promise.resolve();
      let req: ClientRequest | null = null;
      const settle = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const fail = (error: unknown) => {
        settle(error instanceof Error ? error : new Error(String(error)));
        req?.destroy();
      };
      const queueEvent = (event: SignalSseEvent) => {
        pendingEvents = pendingEvents
          .then(async () => {
            if (settled) {
              return;
            }
            await onEvent(event);
          })
          .catch((error: unknown) => {
            fail(
              new Error(
                `Signal event handler failed for event=${event.event ?? "message"} id=${event.id ?? "<none>"} data=${previewSignalEventData(event)}: ${formatSignalClientError(error)}`,
              ),
            );
          });
      };

      const flushBlock = (block: string) => {
        if (!block.trim()) {
          return;
        }
        const event: SignalSseEvent = { ...activeEvent };
        const dataLines: string[] = [];
        for (const rawLine of block.split(/\r?\n/)) {
          const line = rawLine.trimEnd();
          if (!line || line.startsWith(":")) {
            continue;
          }
          const separatorIndex = line.indexOf(":");
          const field =
            separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
          const value =
            separatorIndex >= 0
              ? line.slice(separatorIndex + 1).replace(/^ /, "")
              : "";
          if (field === "event") {
            event.event = value;
          } else if (field === "data") {
            dataLines.push(value);
          } else if (field === "id") {
            event.id = value;
          } else if (field === "retry") {
            event.retry = value;
          }
        }
        if (dataLines.length > 0) {
          event.data = dataLines.join("\n");
        }
        activeEvent = event.id ? { id: event.id } : {};
        if (event.data === undefined && event.event === undefined) {
          return;
        }
        if (event.data === "[DONE]") {
          return;
        }
        queueEvent(event);
      };

      req = getRequest(url)(createRequestOptions(url, "GET"), (response) => {
        const statusCode = response.statusCode ?? 0;
        if (statusCode < 200 || statusCode >= 300) {
          readResponseBody(response, 64_000)
            .then((body) => {
              settle(
                new Error(
                  `Signal event stream GET ${url.pathname} failed with HTTP ${statusCode}${body ? `: ${body}` : ""}`,
                ),
              );
            })
            .catch((error: unknown) => {
              settle(error instanceof Error ? error : new Error(String(error)));
            });
          return;
        }
        req?.setTimeout(0);
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          buffer += chunk;
          if (buffer.length > 1_048_576) {
            settle(
              new Error("Signal event stream buffer exceeded size limit."),
            );
            req?.destroy();
            return;
          }
          let boundary = buffer.search(/\r?\n\r?\n/);
          while (boundary >= 0) {
            const block = buffer.slice(0, boundary);
            buffer = buffer.slice(
              boundary + (buffer[boundary] === "\r" ? 4 : 2),
            );
            flushBlock(block);
            boundary = buffer.search(/\r?\n\r?\n/);
          }
        });
        response.on("end", () => {
          if (buffer.trim()) {
            flushBlock(buffer);
          }
          pendingEvents.then(() => settle()).catch(fail);
        });
        response.on("error", (error) => settle(error));
      });

      req.setTimeout(this.requestTimeoutMs, () => {
        req?.destroy(new Error("Signal request timed out."));
      });
      req.on("error", (error) => {
        if (signal?.aborted) {
          settle();
          return;
        }
        settle(error);
      });
      signal?.addEventListener(
        "abort",
        () => {
          req?.destroy();
          settle();
        },
        { once: true },
      );
      req.end();
    });
  }

  private withAccount(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    if (!this.account || params.account !== undefined) {
      return params;
    }
    return { ...params, account: this.account };
  }

  private request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const encodedBody = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = getRequest(url)(
        {
          ...createRequestOptions(url, method),
          headers: {
            Accept: "application/json",
            ...(encodedBody
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(encodedBody),
                }
              : {}),
          },
        },
        (response) => {
          readResponseBody(response, 2_097_152)
            .then((text) => {
              const statusCode = response.statusCode ?? 0;
              if (statusCode < 200 || statusCode >= 300) {
                reject(
                  new Error(
                    `Signal request failed with HTTP ${statusCode}${text ? `: ${text}` : ""}`,
                  ),
                );
                return;
              }
              resolve(parseJson(text));
            })
            .catch(reject);
        },
      );
      req.setTimeout(this.requestTimeoutMs, () => {
        req?.destroy(new Error("Signal request timed out."));
      });
      req.on("error", reject);
      if (encodedBody) {
        req.write(encodedBody);
      }
      req.end();
    });
  }
}
