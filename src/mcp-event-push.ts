import { setTimeout as delay } from "node:timers/promises";
import type {
  Client,
  Notification,
  RequestId,
} from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  emptyResult,
  eventCursor,
  eventError,
  type McpEventNotice,
  occurrence,
  recentEventIds,
} from "@/mcp-event-protocol";

const SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";
const MAX_TIMEOUT_MS = 2_147_483_647;
const active = z.object({
  cursor: eventCursor,
  truncated: z.boolean(),
  heartbeatMs: z.number().positive(),
});
const errorEnvelope = z.object({ error: eventError });

export interface EventPushConnection {
  client: Client;
  observeStreamRequest: (handler?: (id: RequestId) => () => void) => void;
  disconnected: AbortSignal;
}

export async function watchEventPush(input: {
  connection: () => Promise<EventPushConnection>;
  server: string;
  name: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  notice: (notice: McpEventNotice) => Promise<void>;
  signal: AbortSignal;
}) {
  const { connection, server, name, args, headers, notice, signal } = input;
  const seen = recentEventIds();
  let cursor: string | null = null;

  while (!signal.aborted) {
    const { client, observeStreamRequest, disconnected } = await connection();
    const stream = new AbortController();
    const streamSignal = AbortSignal.any([signal, stream.signal, disconnected]);
    let requestId: RequestId | undefined;
    let heartbeatMs: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = Promise.resolve();
    let terminated = false;
    let lost = false;
    let error: unknown;

    const resetHeartbeat = () => {
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          lost = true;
          stream.abort();
        },
        heartbeatMs === undefined
          ? 30_000
          : Math.min(MAX_TIMEOUT_MS, heartbeatMs * 3),
      );
    };

    async function receive(notification: Notification) {
      if (signal.aborted || terminated) return;
      const params = notification.params;
      if (notification.method === "notifications/events/active") {
        const grant = active.parse(params);
        heartbeatMs = grant.heartbeatMs;
        resetHeartbeat();
        if (grant.truncated) await notice({ type: "gap", server, name });
        cursor = grant.cursor;
        return;
      }
      if (heartbeatMs === undefined) return;
      switch (notification.method) {
        case "notifications/events/heartbeat":
          cursor = eventCursor.parse(params?.cursor);
          break;
        case "notifications/events/event": {
          const event = occurrence.parse(params);
          if (event.name !== name) return;
          if (!seen.has(event.eventId)) {
            await notice({ type: "event", server, event });
            seen.add(event.eventId);
          }
          cursor = event.cursor;
          break;
        }
        case "notifications/events/error":
        case "notifications/events/terminated": {
          const result = errorEnvelope.parse(params);
          const type =
            notification.method === "notifications/events/terminated"
              ? "terminated"
              : "error";
          await notice({ type, server, name, error: result.error });
          if (type === "terminated") {
            terminated = true;
            stream.abort();
          }
          break;
        }
      }
    }

    observeStreamRequest((id) => {
      requestId = id;
      return () => {
        lost = true;
        stream.abort();
      };
    });
    client.fallbackNotificationHandler = (notification) => {
      if (
        streamSignal.aborted ||
        !notification.method.startsWith("notifications/events/") ||
        requestId === undefined ||
        notification.params?._meta?.[SUBSCRIPTION_ID] !== requestId
      )
        return Promise.resolve();
      if (heartbeatMs !== undefined) resetHeartbeat();
      pending = pending
        .then(() => receive(notification))
        .catch((failure) => {
          error = failure;
          stream.abort();
        });
      return pending;
    };
    resetHeartbeat();
    try {
      await client.request(
        { method: "events/stream", params: { name, arguments: args, cursor } },
        emptyResult,
        {
          headers,
          signal: streamSignal,
          timeout: MAX_TIMEOUT_MS,
        },
      );
    } catch (failure) {
      if (!streamSignal.aborted) throw failure;
    } finally {
      clearTimeout(timer);
      observeStreamRequest();
      client.fallbackNotificationHandler = undefined;
      await pending;
      clearTimeout(timer);
    }
    if (error) throw error;
    if (signal.aborted || terminated || (!lost && !disconnected.aborted))
      return;
    await delay(500 + Math.random() * 1_000, undefined, { signal });
  }
}
