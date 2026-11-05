import { expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:http";
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
    model: "test",
    text: "é",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  let large = false;
  const upstream = createServer((_req, res) => {
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
    secrets: [],
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
    await second.text();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prompt_tokens).toBe(3);
    expect(rows[1]?.capture_status).toBe("size_limit");
    expect(JSON.parse(rows[1]?.response_json ?? "{}")).toEqual({
      omitted: "size_limit",
    });
  } finally {
    await proxy.close();
    upstream.close();
  }
});
