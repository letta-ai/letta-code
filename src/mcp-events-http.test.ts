import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { connectMcpEvents } from "./mcp-events";
import { createMcpOAuthSessionWithStorage } from "./mcp-oauth";

const EXTENSION = "io.modelcontextprotocol/events";
const SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
const timestamp = "2026-11-20T00:00:00Z";
const credentials = {
  Authorization: "Bearer test-mcp",
  "X-Configured": "fixture",
};

const rpcRequest = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.looseObject({
    name: z.string().optional(),
    delivery: z.record(z.string(), z.unknown()).optional(),
    _meta: z.object({
      "io.modelcontextprotocol/clientCapabilities": z.object({
        extensions: z.record(z.string(), z.unknown()),
      }),
    }),
  }),
});

function descriptor(name: string, delivery: string[]) {
  return {
    name,
    delivery,
    inputSchema: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            project: { type: "string", "x-mcp-header": "Project" },
          },
        },
      },
    },
    payloadSchema: { type: "object" },
  };
}

async function listenPort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

function httpFixture(webhookPort?: number) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const statuses: number[] = [];
  const failures: unknown[] = [];
  let streamClosed = false;
  let subscribes = 0;
  let streams = 0;
  let pendingDelivery: Promise<void> | undefined;

  async function postHook(
    secret: string,
    value: object,
    id: string,
    options: {
      forged?: boolean;
      stale?: boolean;
      subscriptionId?: string;
    } = {},
  ) {
    const body = JSON.stringify(value);
    const webhookTimestamp = String(
      Math.floor(Date.now() / 1000) - (options.stale ? 600 : 0),
    );
    const signature = createHmac(
      "sha256",
      Buffer.from(secret.slice(6), "base64"),
    )
      .update(`${id}.${webhookTimestamp}.${body}`)
      .digest("base64");
    return fetch(`http://127.0.0.1:${webhookPort}/callback`, {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        "Webhook-Id": id,
        "Webhook-Timestamp": webhookTimestamp,
        "Webhook-Signature": `v1,${options.forged ? (signature[0] === "A" ? "B" : "A") + signature.slice(1) : signature}`,
        "X-MCP-Subscription-Id":
          options.subscriptionId ?? "subscription-fixture",
      },
    });
  }

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const { id, method, params } = rpcRequest.parse(await request.json());
      calls.push({ method, params });
      try {
        expect(request.method).toBe("POST");
        expect(request.headers.get("authorization")).toBe(
          credentials.Authorization,
        );
        expect(request.headers.get("x-configured")).toBe(
          credentials["X-Configured"],
        );
        expect(request.headers.get("mcp-protocol-version")).toBe("2026-07-28");
        expect(request.headers.get("mcp-method")).toBe(method);
        expect(
          params._meta["io.modelcontextprotocol/clientCapabilities"].extensions[
            EXTENSION
          ],
        ).toEqual({});
        if (params.name) {
          expect(request.headers.get("mcp-name")).toBe(params.name);
          expect(request.headers.get("mcp-param-project")).toBe(
            "=?base64?4piD?=",
          );
        }
        const reply = (result: object) =>
          Response.json({
            jsonrpc: "2.0",
            id,
            result: { resultType: "complete", ...result },
          });
        switch (method) {
          case "server/discover":
            return reply({
              supportedVersions: ["2026-07-28"],
              capabilities: { extensions: { [EXTENSION]: {} } },
            });
          case "events/list":
            expect(request.headers.has("mcp-name")).toBe(false);
            return reply({
              events: [
                descriptor("issue.updated", ["poll", "push", "webhook"]),
                descriptor("issue.closed", ["webhook"]),
                descriptor("issue.opened", ["poll"]),
                descriptor("issue.invalid", ["poll"]),
              ].map((item) =>
                item.name === "issue.invalid"
                  ? {
                      ...item,
                      inputSchema: {
                        properties: {
                          invalid: {
                            type: "number",
                            "x-mcp-header": "Invalid",
                          },
                        },
                      },
                    }
                  : item,
              ),
            });
          case "events/poll":
            expect(params.name).toBe("issue.opened");
            return reply({
              events:
                params.cursor === null
                  ? []
                  : [
                      {
                        eventId: "http-poll",
                        name: params.name,
                        timestamp,
                        data: {},
                      },
                    ],
              cursor: "open-1",
              truncated: false,
              hasMore: params.cursor === null,
              nextPollMs: 0,
            });
          case "events/stream": {
            const attempt = ++streams;
            const stream = new ReadableStream({
              start(controller) {
                function emit(method: string, params: object) {
                  controller.enqueue(
                    new TextEncoder().encode(
                      `data: ${JSON.stringify({ jsonrpc: "2.0", method: `notifications/events/${method}`, params: { ...params, _meta: { [SUBSCRIPTION]: id } } })}\n\n`,
                    ),
                  );
                }
                emit("active", {
                  heartbeatMs: 30_000,
                  cursor: params.cursor,
                  truncated: false,
                });
                emit("event", {
                  eventId: `stream-${attempt}`,
                  name: "issue.updated",
                  timestamp,
                  data: { attempt },
                  cursor: String(attempt),
                });
                if (attempt === 1) controller.close(); // Dropped HTTP stream without a final JSON-RPC result.
              },
              cancel() {
                streamClosed = true;
              },
            });
            request.signal.addEventListener("abort", () => {
              streamClosed = true;
            });
            return new Response(stream, {
              headers: { "Content-Type": "text/event-stream" },
            });
          }
          case "events/subscribe": {
            const initial = subscribes++ === 0;
            const delivery = z
              .object({ mode: z.string(), url: z.string(), secret: z.string() })
              .parse(params.delivery);
            expect(delivery.mode).toBe("webhook");
            expect(delivery.url).toBe("https://callback.example/callback");
            expect(delivery.secret).toMatch(/^whsec_/);
            expect(params.ttlMs).toBeGreaterThan(0);
            if (initial) {
              const challenged = await postHook(
                delivery.secret,
                { type: "verification", challenge: "fixture-nonce" },
                "msg_verification_fixture",
              );
              expect(challenged.status).toBe(200);
              expect(await challenged.json()).toEqual({
                challenge: "fixture-nonce",
              });
              const payload = {
                eventId: "hook-1",
                name: params.name,
                timestamp,
                data: { title: "Delivered by webhook" },
                cursor: "hook-cursor",
              };
              pendingDelivery = (async () => {
                for (const [options, messageId] of [
                  [{ forged: true }, "forged"],
                  [{ stale: true }, "stale"],
                  [{ subscriptionId: "wrong-subscription" }, "wrong"],
                  [{}, "valid"],
                  [{}, "valid"],
                ] as const) {
                  statuses.push(
                    (
                      await postHook(
                        delivery.secret,
                        payload,
                        messageId,
                        options,
                      )
                    ).status,
                  );
                }
              })();
            }
            return reply({
              id: "subscription-fixture",
              refreshBefore: new Date(
                Date.now() + (initial ? 1_000 : 60_000),
              ).toISOString(),
              cursor: params.cursor,
              truncated: false,
            });
          }
          case "events/unsubscribe":
            expect(params.delivery).toEqual({
              url: "https://callback.example/callback",
            });
            return reply({});
          default:
            throw new Error(`Unexpected method ${method}`);
        }
      } catch (error) {
        failures.push(error);
        return Response.json({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: String(error) },
        });
      }
    },
  });
  return {
    config: {
      name: "fixture",
      transport: "http" as const,
      url: server.url.href,
      headers: credentials,
    },
    calls,
    failures,
    statuses,
    stop: () => server.stop(true),
    closed: () => streamClosed,
    delivery: () => pendingDelivery,
  };
}

async function waitFor(condition: () => boolean, timeout = 3000) {
  const end = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= end) throw new Error("Timed out waiting for fixture");
    await delay(10);
  }
}

const args = { filter: { project: "☃" } };

test("routes Streamable HTTP push, resumes after a dropped stream and aborts its POST", async () => {
  const fixture = httpFixture();
  const connection = await connectMcpEvents(fixture.config);
  const stop = new AbortController();
  try {
    expect((await connection.list()).map(({ name }) => name)).toEqual([
      "issue.updated",
      "issue.closed",
      "issue.opened",
    ]);
    const ids: string[] = [];
    await connection.watch(
      "issue.updated",
      args,
      (notice) => {
        if (notice.type !== "event") return;
        ids.push(notice.event.eventId);
        if (ids.length === 2) stop.abort();
      },
      AbortSignal.any([stop.signal, AbortSignal.timeout(6000)]),
    );
    expect(ids).toEqual(["stream-1", "stream-2"]);
    expect(
      fixture.calls
        .filter(({ method }) => method === "events/stream")
        .map(({ params }) => params.cursor),
    ).toEqual([null, "1"]);
    await waitFor(fixture.closed);
    expect(
      fixture.calls.some(({ method }) => method === "notifications/cancelled"),
    ).toBe(false);
    expect(fixture.failures).toEqual([]);
  } finally {
    await connection.close();
    await fixture.stop();
  }
}, 8000);

test("verifies webhook challenge and raw signatures, deduplicates, refreshes and unsubscribes", async () => {
  const port = await listenPort();
  const fixture = httpFixture(port);
  const connection = await connectMcpEvents(fixture.config);
  const stop = new AbortController();
  const ids: string[] = [];
  const watch = connection.watch(
    "issue.updated",
    args,
    (notice) => {
      if (notice.type === "event") ids.push(notice.event.eventId);
    },
    stop.signal,
    { url: new URL("https://callback.example/callback"), port },
  );
  // Attach a rejection handler immediately so failures can be inspected after cleanup.
  void watch.catch(() => undefined);
  try {
    await waitFor(
      () =>
        fixture.calls.filter(({ method }) => method === "events/subscribe")
          .length > 1,
    );
    await fixture.delivery();
    expect(fixture.statuses).toEqual([401, 401, 401, 204, 204]);
    expect(ids).toEqual(["hook-1"]);
    const subscriptions = fixture.calls.filter(
      ({ method }) => method === "events/subscribe",
    );
    expect(subscriptions.map(({ params }) => params.cursor)).toEqual([
      null,
      "hook-cursor",
    ]);
    stop.abort();
    await watch;
    expect(fixture.calls.at(-1)?.method).toBe("events/unsubscribe");
    expect(fixture.calls.some(({ method }) => method === "events/stream")).toBe(
      false,
    );
    expect(fixture.failures).toEqual([]);
  } finally {
    stop.abort();
    await watch.catch(() => undefined);
    await connection.close();
    await fixture.stop();
  }
}, 8000);

test("polls over Streamable HTTP using the existing saved OAuth provider", async () => {
  const fixture = httpFixture();
  const { Authorization: _authorization, ...headers } = fixture.config.headers;
  const oauth = await createMcpOAuthSessionWithStorage({
    credentialKey: "mcp-events-http-fixture",
    interactive: false,
    storage: {
      get: async () =>
        JSON.stringify({
          redirectUrl: "http://127.0.0.1:55555/callback",
          clientInformation: { client_id: "fixture" },
          tokens: { access_token: "test-mcp", token_type: "Bearer" },
        }),
      set: async () => {},
      delete: async () => {},
    },
  });
  expect(oauth).toBeDefined();
  const connection = await connectMcpEvents(
    { ...fixture.config, headers },
    { oauth },
  );
  const stop = new AbortController();
  try {
    const ids: string[] = [];
    await connection.watch(
      "issue.opened",
      args,
      (notice) => {
        if (notice.type === "event") {
          ids.push(notice.event.eventId);
          stop.abort();
        }
      },
      AbortSignal.any([stop.signal, AbortSignal.timeout(3000)]),
    );
    expect(ids).toEqual(["http-poll"]);
    expect(
      fixture.calls
        .filter(({ method }) => method === "events/poll")
        .map(({ params }) => params.cursor),
    ).toEqual([null, "open-1"]);
    expect(fixture.failures).toEqual([]);
  } finally {
    await connection.close();
    await fixture.stop();
  }
});

test("only accepts the preview capability on Vercel's discovery response", async () => {
  const methods: string[] = [];
  const fetch = async (_url: string | URL, init?: RequestInit) => {
    if (typeof init?.body !== "string") throw new Error("Expected JSON-RPC");
    const { id, method } = rpcRequest.parse(JSON.parse(init.body));
    methods.push(method);
    const body =
      method === "server/discover"
        ? { supportedVersions: ["2026-07-28"], capabilities: { events: {} } }
        : { events: [descriptor("issue.closed", ["webhook"])] };
    return Response.json({
      jsonrpc: "2.0",
      id,
      result: { resultType: "complete", ...body },
    });
  };
  const config = { name: "fixture", transport: "http" as const };
  const connection = await connectMcpEvents(
    { ...config, url: "https://mcp.vercel.com" },
    { fetch },
  );
  try {
    expect((await connection.list()).map(({ name }) => name)).toEqual([
      "issue.closed",
    ]);
    await expect(
      connectMcpEvents({ ...config, url: "https://mcp.example" }, { fetch }),
    ).rejects.toThrow("does not advertise the Events extension");
    expect(methods).toEqual([
      "server/discover",
      "events/list",
      "server/discover",
    ]);
  } finally {
    await connection.close();
  }
});
