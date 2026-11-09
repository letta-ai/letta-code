import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { MAX_TRACE_PAYLOAD_BYTES } from "./external-llm-trace-payload";
import {
  type ExternalTraceRow,
  startTraceProxy,
} from "./external-llm-trace-proxy";

test("forwards request and streaming response bytes unchanged without storing auth", async () => {
  const raw = '{"model":"test","messages":[]}';
  const response =
    'data: {"type":"response.completed","response":{"id":"r","usage":{"input_tokens":2,"output_tokens":3}}}\n\n';
  let upstreamAuth: string | undefined;
  const upstream = createServer(async (req, res) => {
    upstreamAuth = req.headers.authorization;
    let body = "";
    for await (const chunk of req) body += chunk;
    expect(body).toBe(raw);
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const byte of Buffer.from(response)) res.write(Buffer.from([byte]));
    res.end();
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const rows: ExternalTraceRow[] = [];
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const proxy = await startTraceProxy({
    upstream: `http://127.0.0.1:${address.port}`,
    harness: "codex",
    scope: {
      parent_agent_id: "agent-test",
      parent_conversation_id: "conv-test",
      task_id: "task-test",
      worker_session_id: "session-test",
    },
    secrets: [],
    emit: (row) => rows.push(row),
  });
  try {
    const reply = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      headers: {
        authorization: "Bearer private",
        "x-api-key": "private",
        cookie: "private",
        "content-type": "application/json",
      },
      body: raw,
    });
    expect(await reply.text()).toBe(response);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(upstreamAuth).toBe("Bearer private");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("private");
    const row = rows[0];
    if (!row) throw new Error("Missing trace");
    expect(row.prompt_tokens).toBe(2);
    expect(row.completion_tokens).toBe(3);
    expect(JSON.parse(row.response_json).response.id).toBe("r");
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("compressed responses pass through and oversized payloads keep a metadata row", async () => {
  const { gzipSync } = await import("node:zlib");
  const body = JSON.stringify({
    model: "private-model",
    text: "é",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  let large = false;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* consume each request before reusing the connection */
    }
    if (large) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "a".repeat(2 * 1024 * 1024) }));
    } else {
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
      });
      res.end(gzipSync(body));
    }
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const rows: import("./external-llm-trace-proxy").ExternalTraceRow[] = [];
  const proxy = await startTraceProxy({
    upstream: `http://127.0.0.1:${address.port}`,
    harness: "codex",
    scope: {
      parent_agent_id: "a",
      parent_conversation_id: "c",
      task_id: "t",
      worker_session_id: "s",
    },
    secrets: ["private-model"],
    emit: (row) => rows.push(row),
  });
  try {
    const first = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      body: "{}",
    });
    expect(await first.text()).toBe(body);
    large = true;
    const second = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      body: "{}",
    });
    expect(second.status).toBe(200);
    expect((await second.text()).length).toBeGreaterThan(2 * 1024 * 1024);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prompt_tokens).toBe(3);
    expect(JSON.stringify(rows)).not.toContain("private-model");
    expect(rows[1]?.capture_status).toBe("size_limit");
    expect(JSON.parse(rows[1]?.response_json ?? "{}")).toEqual({
      omitted: "size_limit",
    });
    large = false;
    const third = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      body: JSON.stringify({ text: "a".repeat(MAX_TRACE_PAYLOAD_BYTES + 1) }),
    });
    expect(third.status).toBe(200);
    await third.text();
    await proxy.close();
    expect(rows[2]?.capture_status).toBe("size_limit");
    expect(JSON.parse(rows[2]?.request_json ?? "{}")).toEqual({
      omitted: "size_limit",
    });
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("upstream aborts retain an incomplete trace without changing delivered bytes", async () => {
  const partial = 'data: {"type":"response.created"}\n\n';
  const upstream = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(partial);
    setTimeout(() => res.destroy(), 20);
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const rows: ExternalTraceRow[] = [];
  const proxy = await startTraceProxy({
    upstream: `http://127.0.0.1:${address.port}`,
    harness: "codex",
    scope: {
      parent_agent_id: "a",
      parent_conversation_id: "c",
      task_id: "t",
      worker_session_id: "s",
    },
    secrets: [],
    emit: (row) => rows.push(row),
  });
  try {
    const reply = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      body: "{}",
    });
    if (!reply.body) throw new Error("Missing response body");
    const reader = reply.body.getReader();
    // Read until the transport error. Some Bun versions surface a stray
    // "\r\n" chunk before rejecting; the stream must never end cleanly.
    const decoder = new TextDecoder();
    let received = "";
    let endedCleanly = false;
    await expect(
      (async () => {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) {
            endedCleanly = true;
            return;
          }
          received += decoder.decode(chunk.value, { stream: true });
        }
      })(),
    ).rejects.toThrow();
    expect(endedCleanly).toBe(false);
    expect(received.replace(/\r\n$/, "")).toBe(partial);
    await proxy.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capture_status).toBe("incomplete");
    expect(rows[0]?.error_type).toBe("transport_error");
  } finally {
    await proxy.close();
    upstream.close();
  }
});
