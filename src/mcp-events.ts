import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  type JSONRPCMessage,
  type RequestId,
  StreamableHTTPClientTransport,
  type TransportSendOptions,
} from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import {
  type ConnectMcpServerOptions,
  createMcpHttpTransportOptions,
  type HttpMcpServerConfig,
  type StdioMcpServerConfig,
} from "@/mcp-client";
import {
  encodeEventHeader,
  eventHeaderDeclarations,
  eventHttpHeaders,
} from "@/mcp-event-http-headers";
import {
  emptyResult,
  eventList,
  type McpEventNotice,
  pollResult,
} from "@/mcp-event-protocol";
import { watchEventPush } from "@/mcp-event-push";
import { openMcpEventState } from "@/mcp-event-state";
import { validateMcpEventArguments } from "@/mcp-event-validation";
import {
  type EventWebhookOptions,
  watchEventWebhook,
} from "@/mcp-event-webhook";
import { isRecord } from "@/utils/type-guards";

const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
const EXTENSIONS = { [EVENTS_EXTENSION]: {} };
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 2_147_483_647;
const BATCH_SIZE = 50;
const NAMED_EVENT_METHODS = new Set([
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe",
]);

type ObserveStream = (id: RequestId) => () => void;

function streamRequestId(message: JSONRPCMessage): RequestId | undefined {
  if (
    "method" in message &&
    message.method === "events/stream" &&
    "id" in message
  ) {
    return message.id;
  }
  return undefined;
}

class EventsHttpTransport extends StreamableHTTPClientTransport {
  observeStream?: ObserveStream;

  override send(message: JSONRPCMessage, options?: TransportSendOptions) {
    const id = streamRequestId(message);
    return super.send(
      message,
      id === undefined
        ? options
        : { ...options, onRequestStreamEnd: this.observeStream?.(id) },
    );
  }
}

class EventsStdioTransport extends StdioClientTransport {
  observeStream?: ObserveStream;

  override send(message: JSONRPCMessage) {
    const id = streamRequestId(message);
    if (id !== undefined) this.observeStream?.(id);
    return super.send(message);
  }
}

export type EventDelivery = "poll" | "push" | "webhook";

export interface McpEventWatchOptions {
  delivery?: EventDelivery;
  maxAgeMs?: number;
  minPollMs?: number;
  agentId?: string;
}

export async function connectMcpEvents(
  config: StdioMcpServerConfig | HttpMcpServerConfig,
  { signal, oauth, fetch }: ConnectMcpServerOptions = {},
) {
  signal?.throwIfAborted();
  const lifetime = new AbortController();
  const connectionSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;

  async function open(connectSignal: AbortSignal) {
    const client = new Client(
      { name: "letta-code", version: "0" },
      {
        versionNegotiation: { mode: { pin: "2026-07-28" } },
        capabilities: { extensions: EXTENSIONS },
      },
    );
    let vercelPreview = false;
    const transport =
      config.transport === "http"
        ? new EventsHttpTransport(new URL(config.url), {
            ...createMcpHttpTransportOptions(config, { oauth }),
            // The SDK reserves Mcp-Name for its built-in method table, which
            // does not yet know the Events extension.
            fetch: async (url, init) => {
              const headers = new Headers(init?.headers);
              const method = headers.get("mcp-method");
              if (
                method &&
                NAMED_EVENT_METHODS.has(method) &&
                typeof init?.body === "string"
              ) {
                const name: unknown = JSON.parse(init.body).params?.name;
                if (typeof name === "string")
                  headers.set("mcp-name", encodeEventHeader(name));
              }
              const response = await (fetch ?? globalThis.fetch)(url, {
                ...init,
                headers,
              });
              // The SDK drops unknown capability keys. Inspect a clone of
              // Vercel's JSON discovery response before handing it to the SDK.
              if (
                method === "server/discover" &&
                new URL(url).origin === "https://mcp.vercel.com" &&
                response.ok &&
                response.headers
                  .get("content-type")
                  ?.includes("application/json")
              ) {
                const raw: unknown = await response
                  .clone()
                  .json()
                  .catch(() => undefined);
                vercelPreview =
                  isRecord(raw) &&
                  isRecord(raw.result) &&
                  Array.isArray(raw.result.supportedVersions) &&
                  isRecord(raw.result.capabilities) &&
                  isRecord(raw.result.capabilities.events);
              }
              return response;
            },
          })
        : new EventsStdioTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: { ...getDefaultEnvironment(), ...config.env },
            stderr: "inherit",
          });
    const disconnected = new AbortController();
    client.onclose = () => disconnected.abort();
    try {
      await client.connect(transport, { signal: connectSignal });
      const capabilities = client.getServerCapabilities();
      if (
        !Object.hasOwn(capabilities?.extensions ?? {}, EVENTS_EXTENSION) &&
        !vercelPreview
      ) {
        throw new Error(
          `MCP server "${config.name}" does not advertise the Events extension`,
        );
      }
      return {
        client,
        listChanged:
          capabilities?.extensions?.[EVENTS_EXTENSION]?.listChanged === true,
        disconnected: disconnected.signal,
        observeStreamRequest(handler?: ObserveStream) {
          transport.observeStream = handler;
        },
      };
    } catch (error) {
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  let current: Awaited<ReturnType<typeof open>>;
  try {
    current = await open(connectionSignal);
  } catch (error) {
    await oauth?.close();
    throw error;
  }
  let watching = false;
  let catalog: ReturnType<typeof eventList.parse>["events"] | undefined;
  async function list(listSignal = connectionSignal) {
    const events: ReturnType<typeof eventList.parse>["events"] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await current.client.request(
        {
          method: "events/list",
          params: cursor === undefined ? {} : { cursor },
        },
        eventList,
        { signal: listSignal },
      );
      for (const event of page.events) {
        if (config.transport === "http") {
          try {
            eventHeaderDeclarations(event.inputSchema);
          } catch {
            process.stderr.write(
              "Skipping MCP event with an invalid x-mcp-header declaration.\n",
            );
            continue;
          }
        }
        events.push(event);
      }
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor))
          throw new Error("MCP server repeated an events/list cursor");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    catalog = events;
    return events;
  }

  function followCatalog(connection: typeof current, signal: AbortSignal) {
    if (!connection.listChanged) return;
    connection.client.setNotificationHandler(
      "notifications/events/list_changed",
      { params: emptyResult },
      async () => {
        try {
          await list(signal);
        } catch {
          if (!signal.aborted)
            process.stderr.write("Could not refresh the MCP event catalog.\n");
        }
      },
    );
    // The extension adds this field to the SDK's core filter.
    const filter = { eventsListChanged: true } as Parameters<
      Client["listen"]
    >[0];
    void (async () => {
      const listening = AbortSignal.any([signal, connection.disconnected]);
      while (!listening.aborted) {
        try {
          const subscription = await connection.client.listen(filter, {
            signal: listening,
          });
          if ((await subscription.closed) !== "remote") return;
        } catch {
          if (!listening.aborted)
            process.stderr.write(
              "Could not listen for MCP event catalog changes.\n",
            );
          return;
        }
        await delay(1000, undefined, { signal: listening });
      }
    })().catch(() => undefined);
  }

  return {
    list,
    async watch(
      name: string,
      args: Record<string, unknown>,
      onNotice: (notice: McpEventNotice) => void | Promise<void>,
      subscriptionSignal: AbortSignal,
      webhook?: EventWebhookOptions,
      options: McpEventWatchOptions = {},
    ) {
      if (watching)
        throw new Error("This MCP connection is already watching an event");
      watching = true;
      const watchLifetime = new AbortController();
      const watchSignal = AbortSignal.any([
        connectionSignal,
        subscriptionSignal,
        watchLifetime.signal,
      ]);
      let termination: number | undefined;
      let progress: ReturnType<typeof openMcpEventState>;
      const identity = options.agentId
        ? [options.agentId, config, name, args, webhook?.url.href]
        : undefined;
      async function run() {
        const event = (catalog ?? (await list(watchSignal))).find(
          (entry) => entry.name === name,
        );
        if (!event) throw new Error(`Unknown MCP event "${name}"`);
        validateMcpEventArguments(event.inputSchema, args);
        const mode =
          options.delivery ??
          (webhook && event.delivery.includes("webhook")
            ? "webhook"
            : event.delivery.includes("push")
              ? "push"
              : event.delivery.includes("poll")
                ? "poll"
                : "webhook");
        if (!event.delivery.includes(mode)) {
          throw new Error(
            `MCP event "${name}" does not offer ${mode} delivery`,
          );
        }
        if (mode === "webhook" && !webhook) {
          throw new Error(
            `MCP event "${name}" requires --webhook-url for delivery`,
          );
        }
        const headers =
          config.transport === "http"
            ? eventHttpHeaders(eventHeaderDeclarations(event.inputSchema), args)
            : undefined;
        const notice = async (value: McpEventNotice) => {
          if (value.type !== "event") {
            await onNotice(value);
            if (value.type === "terminated") termination = value.error.code;
          } else if (!progress.seen(value.event.eventId)) {
            await onNotice(value);
            progress.mark(value.event.eventId);
          }
        };
        const watch = {
          server: config.name,
          name,
          args,
          headers,
          notice,
          signal: watchSignal,
          progress,
          maxAgeMs: options.maxAgeMs,
        };
        if (mode === "webhook" && webhook) {
          await watchEventWebhook({
            ...watch,
            client: current.client,
            webhook,
          });
          return;
        }
        if (mode === "push") {
          await watchEventPush({
            ...watch,
            connection: async () => {
              if (current.disconnected.aborted) {
                current = await open(watchSignal);
                followCatalog(current, watchSignal);
              }
              return current;
            },
          });
          return;
        }
        while (!watchSignal.aborted) {
          const cursor = progress.cursor();
          const page: ReturnType<typeof pollResult.parse> =
            await current.client.request(
              {
                method: "events/poll",
                params: {
                  name,
                  arguments: args,
                  cursor,
                  maxEvents: BATCH_SIZE,
                  maxAgeMs: options.maxAgeMs,
                },
              },
              pollResult,
              { signal: watchSignal, headers },
            );
          watchSignal.throwIfAborted();
          if (page.truncated && page.cursor !== null) {
            await notice({ type: "gap", server: config.name, name });
          }
          for (const event of page.events) {
            watchSignal.throwIfAborted();
            if (event.name !== name) continue;
            await notice({ type: "event", server: config.name, event });
          }
          progress.advance(page.cursor);
          // A backlog must advance its cursor to qualify for immediate draining.
          if (!page.hasMore || page.cursor === cursor || page.cursor === null) {
            await delay(
              Math.min(
                MAX_POLL_MS,
                Math.max(options.minPollMs ?? MIN_POLL_MS, page.nextPollMs),
              ),
              undefined,
              { signal: watchSignal },
            );
          }
        }
      }
      try {
        watchSignal.throwIfAborted();
        progress = openMcpEventState(identity);
        catalog = undefined;
        followCatalog(current, watchSignal);
        try {
          await run();
        } catch (error) {
          const code = isRecord(error) ? error.code : undefined;
          if (code !== -32020 && code !== -32023 && code !== -32026)
            throw error;
          termination = code;
        }
        if (
          !watchSignal.aborted &&
          (termination === -32020 ||
            termination === -32023 ||
            termination === -32026)
        ) {
          // Fetch and validate the current descriptor before retrying once.
          await list(watchSignal);
          await run();
        }
      } catch (error) {
        if (!watchSignal.aborted) throw error;
      } finally {
        watchLifetime.abort();
        current.client.removeNotificationHandler(
          "notifications/events/list_changed",
        );
        watching = false;
      }
    },
    close: async () => {
      if (lifetime.signal.aborted) return;
      lifetime.abort();
      await Promise.all([current.client.close(), oauth?.close()]);
    },
  };
}
