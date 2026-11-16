import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";

let previousMode = resolveBackendMode();
beforeEach(() => {
  previousMode = resolveBackendMode();
  setConfiguredBackendMode("api");
});
afterEach(() => setConfiguredBackendMode(previousMode));

import { once } from "node:events";
import { createServer } from "node:http";
import { ApiRequestError } from "@/backend/api/request";
import type { ExternalTraceRow } from "./external-llm-trace-proxy";
import { createTraceSession } from "./external-llm-trace-session";

const context = {
  parent_agent_id: "agent-test",
  parent_conversation_id: "conv-test",
  task_id: "task-test",
  actingUserId: "user-test",
  secretValues: ["vault-value-from-arbitrary-name"],
};
test("opt-out never resolves credentials or starts an upload", async () => {
  let calls = 0;
  const deps = {
    getConfig: async () => {
      calls++;
      return { baseUrl: "https://api.letta.com", apiKey: "key" };
    },
    upload: async () => {
      calls++;
    },
  };
  expect(
    await createTraceSession(
      "codex",
      context,
      { DO_NOT_TRACK: "1" },
      "https://api.openai.com/v1",
      "session",
      deps,
    ),
  ).toBeUndefined();
  setConfiguredBackendMode("local");
  expect(
    await createTraceSession(
      "codex",
      context,
      {},
      "https://api.openai.com/v1",
      "session",
      deps,
    ),
  ).toBeUndefined();
  setConfiguredBackendMode("api");
  expect(calls).toBe(0);
  expect(
    await createTraceSession(
      "codex",
      context,
      {},
      "https://api.openai.com/v1",
      "session",
      {
        ...deps,
        getConfig: async () => ({
          baseUrl: "http://localhost:8283",
          apiKey: "key",
        }),
      },
    ),
  ).toBeUndefined();
  expect(calls).toBe(0);
});
test("flush batches retain native session/task IDs and acting-user attribution", async () => {
  const previous = process.env.LETTA_CODE_TELEM;
  process.env.LETTA_CODE_TELEM = "1";
  const upstream = createServer(async (req, res) => {
    // Drain the POST body before replying so the connection can be reused.
    for await (const _chunk of req) {
      /* consume the request */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"model":"test","usage":{"input_tokens":1,"output_tokens":2}}');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const batches: ExternalTraceRow[][] = [];
  const trace = await createTraceSession(
    "codex",
    context,
    {},
    `http://127.0.0.1:${address.port}`,
    "session-test",
    {
      getConfig: async () => ({
        baseUrl: "https://api.letta.com",
        apiKey: "upload-credential",
      }),
      upload: async (rows, _config, scope) => {
        expect(scope.actingUserId).toBe("user-test");
        batches.push(rows);
      },
    },
  );
  expect(trace).toBeDefined();
  try {
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${trace?.url}/responses`, {
        method: "POST",
        body: '{"model":"test","messages":[{"content":"vault-value-from-arbitrary-name upload-credential"}]}',
      });
      await response.text();
    }
    await trace?.close();
    expect(JSON.stringify(batches)).not.toContain(
      "vault-value-from-arbitrary-name",
    );
    expect(JSON.stringify(batches)).not.toContain("upload-credential");
    expect(batches[0]?.[0]).not.toHaveProperty("secretValues");
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    expect(batches[0]?.[0]?.worker_session_id).toBe("session-test");
    expect(batches[0]?.[0]?.task_id).toBe("task-test");
    expect(batches[0]?.[0]).not.toHaveProperty("actingUserId");
  } finally {
    if (previous === undefined) delete process.env.LETTA_CODE_TELEM;
    else process.env.LETTA_CODE_TELEM = previous;
    upstream.close();
  }
});

test("a 503 upload logs a single metadata-only warning per interval", async () => {
  const previous = process.env.LETTA_CODE_TELEM;
  process.env.LETTA_CODE_TELEM = "1";
  const upstream = createServer(async (req, res) => {
    // Drain the POST body before replying so the connection can be reused.
    for await (const _chunk of req) {
      /* consume the request */
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"model":"test"}');
  }).listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string")
    throw new Error("Missing address");
  const warnings: string[] = [];
  let uploads = 0;
  const trace = await createTraceSession(
    "claude_code",
    context,
    {},
    `http://127.0.0.1:${address.port}`,
    "session-503",
    {
      getConfig: async () => ({
        baseUrl: "https://api.letta.com",
        apiKey: "upload-credential",
      }),
      upload: async () => {
        uploads++;
        throw new ApiRequestError(
          "API error (503)",
          503,
          '{"detail":"service unavailable upload-credential"}',
        );
      },
      warn: (message) => warnings.push(message),
    },
  );
  try {
    // Two size-triggered batches (10 rows each), each failing all retries.
    for (let batch = 0; batch < 2; batch++) {
      for (let i = 0; i < 10; i++) {
        const response = await fetch(`${trace?.url}/responses`, {
          method: "POST",
          body: '{"model":"test","input":"secret prompt text"}',
        });
        await response.text();
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    await trace?.close();
    expect(uploads).toBeGreaterThanOrEqual(6);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("status=503");
    expect(warnings[0]).toContain("service unavailable");
    expect(warnings[0]).toContain("harness=claude_code");
    expect(warnings[0]).toContain("conversation=conv-test");
    expect(warnings[0]).toMatch(/rows=\d+/);
    expect(warnings[0]).not.toContain("upload-credential");
    expect(warnings[0]).not.toContain("secret prompt text");
  } finally {
    if (previous === undefined) delete process.env.LETTA_CODE_TELEM;
    else process.env.LETTA_CODE_TELEM = previous;
    upstream.close();
  }
}, 15000);
