import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";
import { __testSetSendMessageStreamImpl } from "@/websocket/app-server-openai";

const TEST_AGENTS = [
  {
    id: "agent-local-111",
    name: "memo",
    created_at: "2026-01-01T00:00:00Z",
  },
  {
    id: "agent-local-222",
    name: "patch",
    created_at: "2026-01-02T00:00:00Z",
  },
];

function fakeBackend(): Backend {
  return {
    listAgents: async () => TEST_AGENTS,
  } as unknown as Backend;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function fakeTurnChunks(): LettaStreamingResponse[] {
  return [
    {
      message_type: "reasoning_message",
      reasoning: "thinking...",
    },
    {
      message_type: "assistant_message",
      content: "Hello ",
    },
    {
      message_type: "assistant_message",
      content: [{ type: "text", text: "world" }],
    },
    {
      message_type: "usage_statistics",
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
    {
      message_type: "stop_reason",
      stop_reason: "end_turn",
    },
  ] as unknown as LettaStreamingResponse[];
}

function stubTurnStream(
  chunks: LettaStreamingResponse[],
  onCall?: (conversationId: string, agentId: string | undefined) => void,
): void {
  __testSetSendMessageStreamImpl(async (conversationId, _messages, opts) => {
    onCall?.(conversationId, opts?.agentId);
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  });
}

function httpUrl(handle: AppServerHandle, path: string): string {
  const url = new URL(handle.url);
  url.protocol = "http:";
  return `${url.origin}${path}`;
}

describe("app-server OpenAI-compatible API", () => {
  let handle: AppServerHandle | null = null;

  afterEach(async () => {
    __testSetSendMessageStreamImpl(null);
    __testSetBackend(null);
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  test("routes are 404 when --openai-api is not set", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
    const response = await fetch(httpUrl(handle, "/v1/models"));
    expect(response.status).toBe(404);
  });

  test("GET /v1/models lists agents as models", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });
    const response = await fetch(httpUrl(handle, "/v1/models"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      data: Array<{ id: string; object: string; owned_by: string }>;
    };
    expect(body.object).toBe("list");
    expect(body.data.map((model) => model.id)).toEqual(["memo", "patch"]);
    expect(body.data[0]?.object).toBe("model");
    expect(body.data[0]?.owned_by).toBe("letta");
  });

  test("honors capability-token auth on /v1 routes", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
      websocketAuth: parseAppServerWebsocketAuthSettings({
        wsAuth: "capability-token",
        wsTokenSha256: sha256Hex("super-secret-token"),
      }),
    });

    const unauthorized = await fetch(httpUrl(handle, "/v1/models"));
    expect(unauthorized.status).toBe(401);

    const wrongToken = await fetch(httpUrl(handle, "/v1/models"), {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(wrongToken.status).toBe(401);

    const authorized = await fetch(httpUrl(handle, "/v1/models"), {
      headers: { authorization: "Bearer super-secret-token" },
    });
    expect(authorized.status).toBe(200);
  });

  test("POST /v1/chat/completions aggregates a turn (non-streaming)", async () => {
    __testSetBackend(fakeBackend());
    const captured = { conversation: "", agent: "" };
    stubTurnStream(fakeTurnChunks(), (conversationId, agentId) => {
      captured.conversation = conversationId;
      captured.agent = agentId ?? "";
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "memo",
        messages: [
          { role: "system", content: "be helpful" },
          { role: "user", content: "say hello" },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      object: string;
      model: string;
      choices: Array<{
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("memo");
    expect(body.choices[0]?.message.content).toBe("Hello world");
    expect(body.choices[0]?.finish_reason).toBe("stop");
    expect(body.usage.prompt_tokens).toBe(11);
    expect(body.usage.total_tokens).toBe(18);
    expect(captured.conversation).toBe("default");
    expect(captured.agent).toBe("agent-local-111");
  });

  test("POST /v1/chat/completions streams SSE chunks", async () => {
    __testSetBackend(fakeBackend());
    stubTurnStream(fakeTurnChunks());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        // Resolving by agent id (rather than name) must also work.
        model: "agent-local-222",
        messages: [{ role: "user", content: "say hello" }],
        stream: true,
      }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const raw = await response.text();
    const events = raw
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.replace(/^data: /, ""));
    expect(events.at(-1)).toBe("[DONE]");

    const parsed = events.slice(0, -1).map(
      (event) =>
        JSON.parse(event) as {
          object: string;
          choices: Array<{
            delta: { role?: string; content?: string };
            finish_reason: string | null;
          }>;
        },
    );
    expect(parsed[0]?.choices[0]?.delta.role).toBe("assistant");
    const text = parsed
      .map((chunk) => chunk.choices[0]?.delta.content ?? "")
      .join("");
    expect(text).toBe("Hello world");
    expect(parsed.at(-1)?.choices[0]?.finish_reason).toBe("stop");
  });

  test("unknown model returns 404 model_not_found", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "does-not-exist",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: string | null };
    };
    expect(body.error.code).toBe("model_not_found");
  });

  test("missing user text returns 400", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "memo",
        messages: [{ role: "system", content: "no user message" }],
      }),
    });
    expect(response.status).toBe(400);
  });
});
