import { expect, test } from "bun:test";
import {
  assembleTraceResponse,
  sanitizeTraceJson,
  traceCaptureEnabled,
} from "./external-llm-trace-payload";

test("strips credentials case-insensitively, including nested headers and known secret values", () => {
  const raw = JSON.stringify({
    headers: {
      Authorization: "Bearer secret",
      "X-API-Key": "secret",
      Cookie: "secret",
      "Set-Cookie": "secret",
      accept: "ok",
    },
    messages: [{ content: "value secret" }],
  });
  const clean = sanitizeTraceJson(raw, ["secret"]);
  expect(clean).not.toContain("secret");
  expect(JSON.parse(clean).headers.accept).toBe("ok");
  expect(JSON.parse(clean).headers.Authorization).toBe("[REDACTED]");
});

test("assembles Anthropic text, tool JSON, thinking and usage, retaining raw events", () => {
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg-1",
        model: "claude",
        content: [],
        usage: { input_tokens: 10, cache_read_input_tokens: 20 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "héllo" },
    },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool", name: "run", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":' },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "1}" },
    },
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 5 },
    },
    { type: "message_stop" },
  ];
  const result = assembleTraceResponse(
    events
      .map((e) => `event: ${e.type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`)
      .join(""),
    true,
  );
  expect(result.complete).toBe(true);
  expect(result.response.content).toEqual([
    { type: "text", text: "héllo" },
    { type: "tool_use", id: "tool", name: "run", input: { a: 1 } },
  ]);
  expect(result.response.usage).toEqual({
    input_tokens: 10,
    cache_read_input_tokens: 20,
    output_tokens: 5,
  });
  expect(result.events).toEqual(events);
});

test("retains final Responses object and marks interrupted streams incomplete", () => {
  const response = {
    id: "resp-1",
    output: [{ text: "ok" }],
    usage: { input_tokens: 4, output_tokens: 2 },
  };
  expect(
    assembleTraceResponse(
      `data: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
      true,
    ).response,
  ).toEqual(response);
  expect(
    assembleTraceResponse('data: {"type":"response.created"}\n\n', true)
      .complete,
  ).toBe(false);
});

test("cloud credentials and telemetry consent are both required", () => {
  expect(traceCaptureEnabled({}, "https://api.letta.com", "key")).toBe(true);
  for (const env of [
    { DO_NOT_TRACK: "1" },
    { LETTA_CODE_TELEM: "0" },
    { LETTA_CODE_TELEM: "false" },
  ])
    expect(traceCaptureEnabled(env, "https://api.letta.com", "key")).toBe(
      false,
    );
  expect(traceCaptureEnabled({}, "http://localhost:8283", "key")).toBe(false);
  expect(traceCaptureEnabled({}, "https://api.letta.com", "")).toBe(false);
});
