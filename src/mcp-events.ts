import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/client/stdio";
import { z } from "zod";
import type { StdioMcpServerConfig } from "@/mcp-client";

const EVENTS_EXTENSION = "io.modelcontextprotocol/events";
const EXTENSIONS = { [EVENTS_EXTENSION]: {} };
const MIN_POLL_MS = 1_000;
const MAX_POLL_MS = 2_147_483_647;
const BATCH_SIZE = 50;
const RECENT_EVENT_LIMIT = 1_000;

const jsonObject = z.record(z.string(), z.unknown());
// The SDK validates and consumes the modern wire resultType before schema validation.
const eventList = z.object({
  events: z.array(
    z
      .object({
        name: z.string(),
        description: z.string().optional(),
        delivery: z.array(z.enum(["poll", "push", "webhook"])).min(1),
        inputSchema: jsonObject,
        payloadSchema: jsonObject,
      })
      .passthrough(),
  ),
  nextCursor: z.string().optional(),
});

const occurrence = z.object({
  eventId: z.string(),
  name: z.string(),
  timestamp: z.string(),
  data: jsonObject,
});

const pollResult = z.object({
  events: z.array(occurrence),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().nonnegative(),
});

export type McpEventNotice =
  | { type: "event"; server: string; event: z.infer<typeof occurrence> }
  | { type: "gap"; server: string; name: string };

export async function connectMcpEvents(
  config: StdioMcpServerConfig,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const client = new Client(
    { name: "letta-code", version: "0" },
    {
      versionNegotiation: { mode: { pin: "2026-07-28" } },
      capabilities: { extensions: EXTENSIONS },
    },
  );
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    cwd: config.cwd,
    env: { ...getDefaultEnvironment(), ...config.env },
    stderr: "inherit",
  });
  const lifetime = new AbortController();
  const connectionSignal = signal
    ? AbortSignal.any([signal, lifetime.signal])
    : lifetime.signal;

  async function list(listSignal = connectionSignal) {
    const events: z.infer<typeof eventList>["events"] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await client.request(
        {
          method: "events/list",
          params: cursor === undefined ? {} : { cursor },
        },
        eventList,
        { signal: listSignal },
      );
      events.push(...page.events);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        if (seen.has(cursor))
          throw new Error("MCP server repeated an events/list cursor");
        seen.add(cursor);
      }
    } while (cursor !== undefined);
    return events;
  }

  try {
    await client.connect(transport, { signal: connectionSignal });
    if (
      !Object.hasOwn(
        client.getServerCapabilities()?.extensions ?? {},
        EVENTS_EXTENSION,
      )
    ) {
      throw new Error(
        `MCP server "${config.name}" does not advertise the Events extension`,
      );
    }
    return {
      list,
      async watch(
        name: string,
        args: Record<string, unknown>,
        onNotice: (notice: McpEventNotice) => void | Promise<void>,
        subscriptionSignal: AbortSignal,
      ) {
        const watchSignal = AbortSignal.any([
          connectionSignal,
          subscriptionSignal,
        ]);
        try {
          watchSignal.throwIfAborted();
          const event = (await list(watchSignal)).find(
            (entry) => entry.name === name,
          );
          if (!event?.delivery.includes("poll")) {
            throw new Error(
              `MCP event "${name}" is unavailable for poll delivery`,
            );
          }
          let cursor: string | null = null;
          const recent = new Set<string>();
          while (!watchSignal.aborted) {
            const page: z.infer<typeof pollResult> = await client.request(
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
              { signal: watchSignal },
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
              if (recent.size > RECENT_EVENT_LIMIT) {
                const oldest = recent.values().next().value;
                if (oldest !== undefined) recent.delete(oldest);
              }
            }
            // A backlog must advance its cursor to qualify for immediate draining.
            if (
              !page.hasMore ||
              page.cursor === cursor ||
              page.cursor === null
            ) {
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
        }
      },
      close: async () => {
        if (lifetime.signal.aborted) return;
        lifetime.abort();
        await client.close();
      },
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
