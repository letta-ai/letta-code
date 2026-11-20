import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/client";
import { z } from "zod";
import {
  emptyResult,
  eventCursor,
  eventError,
  type McpEventNotice,
  occurrence,
  recentEventIds,
} from "@/mcp-event-protocol";
import { isRecord } from "@/utils/type-guards";

const subscribeResult = z.object({
  id: z.string().min(1),
  refreshBefore: z.iso.datetime({ offset: true }),
  cursor: eventCursor,
  truncated: z.boolean(),
  deliveryStatus: z
    .object({
      active: z.boolean(),
      lastError: z.string().nullish(),
    })
    .optional(),
});

const verification = z.object({
  type: z.literal("verification"),
  challenge: z.string().min(1),
});
const control = z.discriminatedUnion("type", [
  z.object({ type: z.literal("gap"), cursor: eventCursor }),
  z.object({ type: z.literal("terminated"), error: eventError }),
]);

const MAX_BODY_BYTES = 256 * 1024;
const WEBHOOK_TTL_MS = 5 * 60_000;
const TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export interface EventWebhookOptions {
  url: URL;
  port: number;
}

function verify(
  request: IncomingMessage,
  body: Buffer,
  secret: Buffer,
): string | undefined {
  const id = request.headers["webhook-id"];
  const timestamp = request.headers["webhook-timestamp"];
  const signatures = request.headers["webhook-signature"];
  if (
    typeof id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(id) ||
    typeof timestamp !== "string" ||
    !/^\d{1,12}$/.test(timestamp) ||
    Math.abs(Date.now() / 1000 - Number(timestamp)) >
      TIMESTAMP_TOLERANCE_SECONDS ||
    typeof signatures !== "string"
  )
    return undefined;

  const expected = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.`)
    .update(body)
    .digest();
  const valid = signatures.split(/\s+/).some((signature) => {
    if (!/^v1,[a-zA-Z0-9+/]{43}=$/.test(signature)) return false;
    return timingSafeEqual(expected, Buffer.from(signature.slice(3), "base64"));
  });
  return valid ? id : undefined;
}

async function readBody(request: IncomingMessage): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Keep the socket writable long enough to return 413 if iteration ends early.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export async function watchEventWebhook(input: {
  client: Client;
  server: string;
  name: string;
  args: Record<string, unknown>;
  headers?: Record<string, string>;
  webhook: EventWebhookOptions;
  notice: (notice: McpEventNotice) => Promise<void>;
  signal: AbortSignal;
}) {
  const { client, server, name, args, headers, webhook, notice, signal } =
    input;
  signal.throwIfAborted();
  const secret = randomBytes(32);
  const seen = recentEventIds();
  const stopped = new AbortController();
  const deliverySignal = AbortSignal.any([signal, stopped.signal]);
  let subscriptionId: string | undefined;
  let cursor: string | null = null;
  let subscribed = false;
  let terminated = false;
  let deliveries = Promise.resolve();

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const finish = (status: number) => response.writeHead(status).end();
    if (deliverySignal.aborted) return finish(503);
    if (request.method !== "POST") return finish(405);
    if (request.url !== `${webhook.url.pathname}${webhook.url.search}`)
      return finish(404);
    const id = request.headers["x-mcp-subscription-id"];
    if (typeof id !== "string" || (subscriptionId && id !== subscriptionId))
      return finish(401);
    const body = await readBody(request);
    if (!body) {
      response.setHeader("Connection", "close");
      return finish(413);
    }
    const messageId = verify(request, body, secret);
    if (!messageId) return finish(401);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body.toString("utf8"));
    } catch {
      return finish(400);
    }
    const delivery = deliveries.then(async () => {
      if (deliverySignal.aborted) return finish(503);
      if (subscriptionId && id !== subscriptionId) return finish(401);
      const challenge = verification.safeParse(decoded);
      if (challenge.success) {
        subscriptionId ??= id;
        return response
          .writeHead(200, { "Content-Type": "application/json" })
          .end(JSON.stringify({ challenge: challenge.data.challenge }));
      }
      if (seen.has(messageId)) return finish(204);
      const envelope = control.safeParse(decoded);
      if (envelope.success) {
        subscriptionId ??= id;
        if (envelope.data.type === "gap") {
          await notice({ type: "gap", server, name });
          cursor = envelope.data.cursor;
        } else {
          await notice({
            type: "terminated",
            server,
            name,
            error: envelope.data.error,
          });
          terminated = true;
          response.once("finish", () => stopped.abort());
        }
      } else {
        if (isRecord(decoded) && Object.hasOwn(decoded, "type"))
          return finish(400);
        const event = occurrence.safeParse(decoded);
        if (!event.success || event.data.name !== name) return finish(400);
        subscriptionId ??= id;
        await notice({ type: "event", server, event: event.data });
        cursor = event.data.cursor;
      }
      seen.add(messageId);
      return finish(204);
    });
    deliveries = delivery.then(
      () => undefined,
      () => undefined,
    );
    return delivery;
  }

  const receiver = createServer(
    { requestTimeout: 15_000, headersTimeout: 10_000 },
    (request, response) => {
      request.on("error", () => response.destroy());
      // Verification can arrive before events/subscribe returns. Serialize only
      // signed deliveries so an incomplete request can't block a challenge.
      void handle(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(503).end();
        else response.destroy();
      });
    },
  );
  const key = { name, arguments: args };
  await new Promise<void>((resolve, reject) => {
    receiver.once("error", reject);
    receiver.listen(webhook.port, "127.0.0.1", () => {
      receiver.off("error", reject);
      resolve();
    });
  });
  try {
    while (!deliverySignal.aborted) {
      subscribed = true; // The server may accept before a response is lost.
      const grant: ReturnType<typeof subscribeResult.parse> =
        await client.request(
          {
            method: "events/subscribe",
            params: {
              ...key,
              delivery: {
                mode: "webhook",
                url: webhook.url.href,
                secret: `whsec_${secret.toString("base64")}`,
              },
              cursor,
              ttlMs: WEBHOOK_TTL_MS,
            },
          },
          subscribeResult,
          { headers, signal: deliverySignal },
        );
      if (subscriptionId && grant.id !== subscriptionId) {
        throw new Error("MCP webhook subscription ID changed");
      }
      subscriptionId = grant.id;
      cursor = grant.cursor;
      if (grant.truncated) await notice({ type: "gap", server, name });
      if (grant.deliveryStatus?.active === false) {
        await notice({
          type: "error",
          server,
          name,
          error: {
            code: -32603,
            message:
              grant.deliveryStatus.lastError ?? "Webhook delivery inactive",
          },
        });
      }
      const remaining = Date.parse(grant.refreshBefore) - Date.now();
      if (remaining <= 0)
        throw new Error("MCP server returned an expired webhook grant");
      await delay(Math.min(2_147_483_647, remaining * 0.8), undefined, {
        signal: deliverySignal,
      });
    }
  } catch (error) {
    if (!deliverySignal.aborted) throw error;
  } finally {
    stopped.abort();
    receiver.close();
    receiver.closeAllConnections();
    if (subscribed && !terminated) {
      await client
        .request(
          {
            method: "events/unsubscribe",
            params: { ...key, delivery: { url: webhook.url.href } },
          },
          emptyResult,
          { headers, timeout: 5_000 },
        )
        .catch((error: unknown) => {
          // NotFound includes a previously terminated or never-created hook.
          if (
            ![-32023, -32011].includes(
              Number((error as { code?: unknown }).code),
            )
          ) {
            process.stderr.write(
              "MCP webhook unsubscribe was unconfirmed. The subscription will expire at its granted TTL.\n",
            );
          }
        });
    }
    await deliveries;
  }
}
