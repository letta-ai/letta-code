import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  type RequestId,
  StreamableHTTPClientTransport,
  type Transport,
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
  eventList,
  type McpEventNotice,
  pollResult,
  recentEventIds,
} from "@/mcp-event-protocol";
import { watchEventPush } from "@/mcp-event-push";
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
    const transport: Transport =
      config.transport === "http"
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            ...createMcpHttpTransportOptions(config, { oauth }),
            // The SDK reserves Mcp-Name for its built-in method table, which
            // does not yet know the Events extension.
            fetch: (url, init) => {
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
              return (fetch ?? globalThis.fetch)(url, { ...init, headers });
            },
          })
        : new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            env: { ...getDefaultEnvironment(), ...config.env },
            stderr: "inherit",
          });
    let observe: ((id: RequestId) => () => void) | undefined;
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (
        "method" in message &&
        message.method === "events/stream" &&
        "id" in message
      ) {
        const onRequestStreamEnd = observe?.(message.id);
        return send(message, { ...options, onRequestStreamEnd });
      }
      return send(message, options);
    };
    let vercelPreview = false;
    if (
      config.transport === "http" &&
      new URL(config.url).origin === "https://mcp.vercel.com"
    ) {
      // The SDK drops unrecognized capability keys during discovery decoding.
      // Vercel still advertises the pre-SEP top-level Events capability.
      let handler = transport.onmessage;
      Object.defineProperty(transport, "onmessage", {
        configurable: true,
        get: () => handler,
        set: (next: Transport["onmessage"]) => {
          handler =
            next &&
            ((message) => {
              if (
                "result" in message &&
                isRecord(message.result?.capabilities) &&
                Array.isArray(message.result.supportedVersions)
              ) {
                vercelPreview = isRecord(message.result.capabilities.events);
              }
              next(message);
            });
        },
      });
    }
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
        disconnected: disconnected.signal,
        observeStreamRequest(handler?: (id: RequestId) => () => void) {
          observe = handler;
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
    return events;
  }

  return {
    list,
    async watch(
      name: string,
      args: Record<string, unknown>,
      onNotice: (notice: McpEventNotice) => void | Promise<void>,
      subscriptionSignal: AbortSignal,
      webhook?: EventWebhookOptions,
    ) {
      if (watching)
        throw new Error("This MCP connection is already watching an event");
      watching = true;
      const watchSignal = AbortSignal.any([
        connectionSignal,
        subscriptionSignal,
      ]);
      try {
        watchSignal.throwIfAborted();
        const event = (await list(watchSignal)).find(
          (entry) => entry.name === name,
        );
        if (!event) throw new Error(`Unknown MCP event "${name}"`);
        const headers =
          config.transport === "http"
            ? eventHttpHeaders(eventHeaderDeclarations(event.inputSchema), args)
            : undefined;
        const notice = async (value: McpEventNotice) => {
          await onNotice(value);
        };
        const watch = {
          server: config.name,
          name,
          args,
          headers,
          notice,
          signal: watchSignal,
        };
        if (webhook) {
          if (!event.delivery.includes("webhook")) {
            throw new Error(
              `MCP event "${name}" does not offer webhook delivery`,
            );
          }
          await watchEventWebhook({
            ...watch,
            client: current.client,
            webhook,
          });
          return;
        }
        if (event.delivery.includes("push")) {
          await watchEventPush({
            ...watch,
            connection: async () => {
              if (current.disconnected.aborted)
                current = await open(watchSignal);
              return current;
            },
          });
          return;
        }
        if (!event.delivery.includes("poll")) {
          throw new Error(
            `MCP event "${name}" requires --webhook-url for delivery`,
          );
        }
        let cursor: string | null = null;
        const recent = recentEventIds();
        while (!watchSignal.aborted) {
          const page: ReturnType<typeof pollResult.parse> =
            await current.client.request(
              {
                method: "events/poll",
                params: {
                  name,
                  arguments: args,
                  cursor,
                  maxEvents: BATCH_SIZE,
                },
              },
              pollResult,
              { signal: watchSignal, headers },
            );
          watchSignal.throwIfAborted();
          if (page.truncated) {
            await onNotice({ type: "gap", server: config.name, name });
          }
          for (const event of page.events) {
            watchSignal.throwIfAborted();
            if (event.name !== name || recent.has(event.eventId)) continue;
            await onNotice({ type: "event", server: config.name, event });
            recent.add(event.eventId);
          }
          // A backlog must advance its cursor to qualify for immediate draining.
          if (!page.hasMore || page.cursor === cursor || page.cursor === null) {
            await delay(
              Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, page.nextPollMs)),
              undefined,
              { signal: watchSignal },
            );
          }
          cursor = page.cursor;
        }
      } catch (error) {
        if (!watchSignal.aborted) throw error;
      } finally {
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
