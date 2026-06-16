import { afterEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { SignalRestClient } from "./client";

const servers: http.Server[] = [];

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function withSignalServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
): Promise<string> {
  const server = http.createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error: unknown) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing test server address");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }),
    ),
  );
});

describe("SignalRestClient", () => {
  test("sends Signal text styles using json-rpc camelCase arrays", async () => {
    let rpcBody: Record<string, unknown> | undefined;
    const baseUrl = await withSignalServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      rpcBody = JSON.parse(await readRequestBody(req)) as Record<
        string,
        unknown
      >;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 123 },
          id: rpcBody.id,
        }),
      );
    });

    const client = new SignalRestClient({ baseUrl, account: "+15555550100" });
    await client.sendMessage({
      target: { kind: "recipient", recipient: "+15555550123" },
      message: "Bold mono",
      textStyle: ["0:4:BOLD", "5:4:MONOSPACE"],
    });

    expect(rpcBody?.method).toBe("send");
    expect(rpcBody?.params).toEqual({
      account: "+15555550100",
      message: "Bold mono",
      recipient: ["+15555550123"],
      textStyle: ["0:4:BOLD", "5:4:MONOSPACE"],
    });
  });

  test("sends Signal reactions with signal-cli plural target params", async () => {
    let rpcBody: Record<string, unknown> | undefined;
    const baseUrl = await withSignalServer(async (req, res) => {
      expect(req.method).toBe("POST");
      expect(req.url).toBe("/api/v1/rpc");
      rpcBody = JSON.parse(await readRequestBody(req)) as Record<
        string,
        unknown
      >;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          result: { timestamp: 456 },
          id: rpcBody.id,
        }),
      );
    });

    const client = new SignalRestClient({ baseUrl, account: "+15555550100" });
    await client.sendReaction({
      target: { kind: "group", groupId: "group-1" },
      emoji: "👍",
      targetTimestamp: 123,
      targetAuthor: "+15555550123",
      remove: true,
    });

    expect(rpcBody?.method).toBe("sendReaction");
    expect(rpcBody?.params).toEqual({
      account: "+15555550100",
      emoji: "👍",
      targetTimestamp: 123,
      targetAuthor: "+15555550123",
      remove: true,
      groupIds: ["group-1"],
    });
  });

  test("waits for asynchronous event handlers before resolving", async () => {
    const baseUrl = await withSignalServer((req, res) => {
      expect(req.method).toBe("GET");
      expect(req.url).toBe("/api/v1/events?account=%2B15555550100");
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end('id: 1\nevent: receive\ndata: {"ok":true}\n\n');
    });
    const client = new SignalRestClient({ baseUrl, account: "+15555550100" });
    const events: Array<{ id?: string; event?: string; data?: string }> = [];

    await client.streamEvents(async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      events.push(event);
    });

    expect(events).toEqual([
      { id: "1", event: "receive", data: '{"ok":true}' },
    ]);
  });

  test("does not apply the request timeout to idle SSE after headers arrive", async () => {
    const baseUrl = await withSignalServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      setTimeout(() => {
        res.end('event: receive\ndata: {"ok":true}\n\n');
      }, 25);
    });
    const client = new SignalRestClient({ baseUrl, requestTimeoutMs: 10 });
    const events: Array<{ event?: string; data?: string }> = [];

    await client.streamEvents((event) => {
      events.push(event);
    });

    expect(events).toEqual([{ event: "receive", data: '{"ok":true}' }]);
  });
});
