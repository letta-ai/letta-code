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
      task_description: "Check private response handling",
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
    expect(row.task_description).toBe("Check [REDACTED] response handling");
    expect(row.prompt_tokens).toBe(2);
    expect(row.completion_tokens).toBe(3);
    expect(JSON.parse(row.response_json).response.id).toBe("r");
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test("compressed responses pass through and each oversized payload is compacted independently", async () => {
  const { gzipSync } = await import("node:zlib");
  const body = JSON.stringify({
    model: "private-model",
    text: "é",
    usage: { input_tokens: 3, output_tokens: 4 },
  });
  let large = false;
  const upstream = createServer(async (req, res) => {
    for await (const _chunk of req) {
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
    secrets: ["private-model", "a"],
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
      text: { truncated: "size_limit" },
      truncated: "size_limit",
    });
    expect(JSON.parse(rows[1]?.request_json ?? "")).toEqual({});
    large = false;
    const third = await fetch(`${proxy.url}/responses`, {
      method: "POST",
      body: JSON.stringify({ text: "a".repeat(300000) }),
    });
    expect(third.status).toBe(200);
    await third.text();
    await proxy.close();
    expect(rows[2]?.capture_status).toBe("size_limit");
    expect(JSON.parse(rows[2]?.request_json ?? "{}")).toEqual({
      text: { truncated: "size_limit" },
      truncated: "size_limit",
    });
    expect(JSON.parse(rows[2]?.response_json ?? "").usage.output_tokens).toBe(
      4,
    );
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
    setTimeout(() => {
      res.socket?.destroy();
      res.destroy();
    }, 20);
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
    expect(received).toBe(partial);
    await proxy.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.capture_status).toBe("incomplete");
    expect(rows[0]?.error_type).toBe("transport_error");
  } finally {
    await proxy.close();
    upstream.close();
  }
});

test.each([undefined, "application/json"])(
  "captures a Codex SSE response with content-type %s",
  async (contentType) => {
    const response = await Bun.file(
      `${import.meta.dir}/__fixtures__/codex-stream.sse`,
    ).text();
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      res.writeHead(200, contentType ? { "content-type": contentType } : {});
      res.end(response);
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
        body: JSON.stringify({ model: "gpt-5-codex", stream: true }),
      });
      expect(reply.status).toBe(200);
      expect(await reply.text()).toBe(response);
      await proxy.close();
      const row = rows[0];
      if (!row) throw new Error("Missing trace");
      expect(row.capture_status).toBe("complete");
      expect(row.prompt_tokens).toBe(16);
      expect(row.completion_tokens).toBe(5);
      expect(row.total_tokens).toBe(21);
      expect(row.cached_input_tokens).toBe(0);
      expect(row.reasoning_tokens).toBe(0);
      const captured = JSON.parse(row.response_json);
      expect(captured.complete).toBe(true);
      expect(captured.response.status).toBe("completed");
      expect(captured.response.output[0].content[0].text).toBe("OK");
      expect(captured.events.at(-1).type).toBe("response.completed");
    } finally {
      await proxy.close();
      upstream.close();
    }
  },
);

test.each(["claude_code", "codex"] as const)(
  "%s captures appended history and falls back when the prefix changes",
  async (harness) => {
    const upstream = createServer(async (req, res) => {
      for await (const _chunk of req) {
      }
      res.end('{"id":"reply"}');
    }).listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const address = upstream.address();
    if (!address || typeof address === "string")
      throw new Error("Missing address");
    const rows: ExternalTraceRow[] = [];
    const proxy = await startTraceProxy({
      upstream: `http://127.0.0.1:${address.port}`,
      harness,
      scope: {
        parent_agent_id: "a",
        parent_conversation_id: "c",
        task_id: "t",
        worker_session_id: "s",
      },
      secrets: ["x"],
      emit: (row) => rows.push(row),
    });
    const historyKey = harness === "claude_code" ? "messages" : "input";
    const path = harness === "claude_code" ? "messages" : "responses";
    const original = { role: "user", content: "x".repeat(190000) };
    const appended = { role: "assistant", content: "é".repeat(120000) };
    const latest = { role: "user", content: "keep this" };
    try {
      for (const payload of [
        { [historyKey]: [original] },
        { [historyKey]: [original, appended] },
        { [historyKey]: [original, appended, latest] },
        {
          system: "x".repeat(30000),
          tools: [{ name: "search" }],
          [historyKey]: [{ ...original, role: "assistant" }, appended, latest],
        },
        { system: "x".repeat(220000), tools: [], [historyKey]: [latest] },
      ]) {
        const reply = await fetch(`${proxy.url}/${path}`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        await reply.text();
      }
      await proxy.close();
      expect(rows.map((row) => row.capture_status)).toEqual([
        "complete",
        "delta",
        "delta",
        "size_limit",
        "size_limit",
      ]);
      expect(JSON.parse(rows[1]?.request_json ?? "")).toEqual({
        [historyKey]: [appended],
        base_trace_id: rows[0]?.id,
        prefix_items: 1,
      });
      expect(JSON.parse(rows[2]?.request_json ?? "")).toEqual({
        [historyKey]: [latest],
        base_trace_id: rows[1]?.id,
        prefix_items: 2,
      });
      expect(JSON.parse(rows[3]?.request_json ?? "")).toEqual({
        [historyKey]: [{ truncated: "size_limit" }, appended, latest],
        truncated: "size_limit",
      });
      expect(JSON.parse(rows[4]?.request_json ?? "")).toEqual({
        [historyKey]: [latest],
        truncated: "size_limit",
      });
      for (const row of rows) {
        expect(Buffer.byteLength(row.request_json)).toBeLessThanOrEqual(
          2 * 1024 * 1024,
        );
        expect(Buffer.byteLength(row.response_json)).toBeLessThanOrEqual(
          2 * 1024 * 1024,
        );
      }
      expect(rows.map((row) => JSON.parse(row.response_json))).toEqual(
        Array.from({ length: 5 }, () => ({ id: "reply" })),
      );
    } finally {
      await proxy.close();
      upstream.close();
    }
  },
);

test("moving cache breakpoints retains images once and oversized image deltas preserve tool results", async () => {
  const forwarded: string[] = [];
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    forwarded.push(Buffer.concat(chunks).toString("utf8"));
    res.end('{"id":"reply"}');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const rows: ExternalTraceRow[] = [];
  const fallbacks: string[] = [];
  const proxy = await startTraceProxy({
    upstream: `http://127.0.0.1:${address.port}`,
    harness: "claude_code",
    scope: {
      parent_agent_id: "a",
      parent_conversation_id: "c",
      task_id: "t",
      worker_session_id: "s",
    },
    secrets: ["X", "Y", "Z"],
    emit: (row, delta) => {
      rows.push(row);
      if (delta) fallbacks.push(delta.fallbackJson);
    },
  });
  const image = (data: string) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: "image/png",
      data,
    },
  });
  const cacheControl = { type: "ephemeral" };
  const screenshot = image("X".repeat(170_000));
  const original = { role: "user", content: [screenshot] };
  const assistant = {
    role: "assistant",
    content: [{ type: "text", text: "Z".repeat(50_000) }],
  };
  const cachedAssistant = {
    ...assistant,
    content: [{ ...assistant.content[0], cache_control: cacheControl }],
  };
  const toolResult = {
    type: "tool_result",
    tool_use_id: "tool-1",
    content: [
      image("Y".repeat(220_000)),
      { type: "text", text: "Tool output to retain" },
      image("D".repeat(128)),
    ],
  };
  const result = { role: "user", content: [toolResult] };
  const last = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const requests = [
    [
      {
        ...original,
        content: [{ ...screenshot, cache_control: cacheControl }],
      },
    ],
    [original, cachedAssistant],
    [original, assistant, result],
    [original, assistant, result, last],
  ].map((messages) => JSON.stringify({ messages }));

  try {
    for (const body of requests) {
      const reply = await fetch(`${proxy.url}/messages`, {
        method: "POST",
        body,
      });
      await reply.text();
    }
    await proxy.close();
    expect(forwarded).toEqual(requests);
    expect(rows.map((row) => row.capture_status)).toEqual([
      "complete",
      "delta",
      "delta",
      "delta",
    ]);
    const [base, firstDelta, imageDelta, finalDelta] = rows.map((row) =>
      JSON.parse(row.request_json),
    );
    expect(base.messages[0].content[0].source).toEqual({
      ...screenshot.source,
      data: "[REDACTED]".repeat(170_000),
    });
    expect(firstDelta.messages).toEqual([
      {
        ...cachedAssistant,
        content: [
          { ...cachedAssistant.content[0], text: "[REDACTED]".repeat(50_000) },
        ],
      },
    ]);
    expect(firstDelta.base_trace_id).toBe(rows[0]?.id);
    expect(imageDelta.base_trace_id).toBe(rows[1]?.id);
    expect(imageDelta.messages).toEqual([
      {
        ...result,
        content: [
          {
            ...toolResult,
            content: [
              { truncated: "size_limit" },
              ...toolResult.content.slice(1),
            ],
          },
        ],
      },
    ]);
    expect(imageDelta.truncated).toBe("size_limit");
    const fallback = JSON.parse(fallbacks[1] ?? "");
    expect(fallback.messages[2]).toEqual(imageDelta.messages[0]);
    expect(fallback.truncated).toBe("size_limit");
    expect(finalDelta.base_trace_id).toBe(rows[2]?.id);
    expect(finalDelta.messages).toEqual([last]);
  } finally {
    await proxy.close();
    upstream.close();
  }
});
