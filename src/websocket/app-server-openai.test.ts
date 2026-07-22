import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";
import {
  __testResetConversationMap,
  __testSetRunTurnImpl,
} from "@/websocket/app-server-openai";

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

function fakeBackend(created: string[] = [], deleted: string[] = []): Backend {
  return {
    listAgents: async () => TEST_AGENTS,
    createConversation: async (body: { agent_id: string }) => {
      const id = `conv-test-${created.length + 1}`;
      created.push(id);
      return { id, agent_id: body.agent_id };
    },
    deleteConversation: async (conversationId: string) => {
      deleted.push(conversationId);
      return {};
    },
  } as unknown as Backend;
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stubTurn(
  onCall?: (
    conversationId: string,
    agentId: string,
    messages: unknown[],
  ) => void,
): void {
  __testSetRunTurnImpl(
    async ({ agentId, conversationId, messages, onAssistantText }) => {
      onCall?.(conversationId, agentId, messages);
      onAssistantText?.("Hello ");
      onAssistantText?.("world");
      return {
        text: "Hello world",
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
        error: null,
      };
    },
  );
}

function httpUrl(handle: AppServerHandle, path: string): string {
  const url = new URL(handle.url);
  url.protocol = "http:";
  return `${url.origin}${path}`;
}

describe("app-server OpenAI-compatible API", () => {
  let handle: AppServerHandle | null = null;

  afterEach(async () => {
    __testSetRunTurnImpl(null);
    __testResetConversationMap();
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
    stubTurn((conversationId, agentId) => {
      captured.conversation = conversationId;
      captured.agent = agentId;
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
    expect(captured.conversation).toBe("conv-test-1");
    expect(captured.agent).toBe("agent-local-111");
  });

  test("header-less requests run statelessly with transcript replay", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    const conversationsUsed: string[] = [];
    const messageCounts: number[] = [];
    stubTurn((conversationId, _agentId, messages) => {
      conversationsUsed.push(conversationId);
      messageCounts.push(messages.length);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = async (messages: unknown[]) =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "memo", messages }),
      });

    // Without a stable chat identity there is no server-side reuse: every
    // request gets a fresh conversation and the transcript is replayed.
    await send([{ role: "user", content: "first chat" }]);
    await send([
      { role: "user", content: "first chat" },
      { role: "assistant", content: "Hello world" },
      { role: "user", content: "follow-up" },
    ]);

    expect(conversationsUsed).toEqual(["conv-test-1", "conv-test-2"]);
    expect(created).toEqual(["conv-test-1", "conv-test-2"]);
    expect(messageCounts).toEqual([1, 3]);
  });

  test("POST /v1/chat/completions streams SSE chunks", async () => {
    __testSetBackend(fakeBackend());
    stubTurn();
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

  test("concurrent new chats serialize conversation creation per agent", async () => {
    const created: string[] = [];
    let inFlight = 0;
    __testSetBackend({
      listAgents: async () => TEST_AGENTS,
      createConversation: async (body: { agent_id: string }) => {
        inFlight += 1;
        if (inFlight > 1) {
          inFlight -= 1;
          throw new Error("concurrent createConversation detected");
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        inFlight -= 1;
        const id = `conv-test-${created.length + 1}`;
        created.push(id);
        return { id, agent_id: body.agent_id };
      },
    } as unknown as Backend);
    stubTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = (text: string) =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: text }],
        }),
      });
    const responses = await Promise.all([
      send("chat one"),
      send("chat two"),
      send("chat three"),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(created.length).toBe(3);
  });

  test("conversation creation failure returns 500, not default fallback", async () => {
    __testSetBackend({
      listAgents: async () => TEST_AGENTS,
      createConversation: async () => {
        throw new Error("could not lock config file .git/config");
      },
    } as unknown as Backend);
    stubTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "memo",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("server_error");
  });

  test("two chats starting with identical messages get distinct conversations", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    const conversationsUsed: string[] = [];
    stubTurn((conversationId) => {
      conversationsUsed.push(conversationId);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = () =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
    await send();
    await send();
    expect(conversationsUsed).toEqual(["conv-test-1", "conv-test-2"]);
  });

  test("chat-key header pins chat identity across identical transcripts", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    const conversationsUsed: string[] = [];
    stubTurn((conversationId) => {
      conversationsUsed.push(conversationId);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = (chatKey: string, messages: unknown[]) =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-letta-chat-key": chatKey,
        },
        body: JSON.stringify({ model: "memo", messages }),
      });

    // Two chats with byte-identical transcripts but different chat ids.
    await send("chat-a", [{ role: "user", content: "Hello" }]);
    await send("chat-b", [{ role: "user", content: "Hello" }]);
    // Follow-up in chat-a with an identical transcript to what chat-b
    // would resend — the header, not the transcript, decides.
    await send("chat-a", [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hello world" },
      { role: "user", content: "follow-up" },
    ]);

    expect(conversationsUsed).toEqual([
      "conv-test-1",
      "conv-test-2",
      "conv-test-1",
    ]);
    expect(created.length).toBe(2);
  });

  test("openwebui chat id is honored only for streaming requests", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    const conversationsUsed: string[] = [];
    stubTurn((conversationId) => {
      conversationsUsed.push(conversationId);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = (stream: boolean) =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openwebui-chat-id": "webui-chat",
        },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: "hi" }],
          stream,
        }),
      });

    // Streaming chat messages pin the conversation; non-streaming task
    // requests (title/tags generation) run statelessly despite the header.
    await send(true);
    await send(true);
    await send(false);

    expect(conversationsUsed).toEqual([
      "conv-test-1",
      "conv-test-1",
      "conv-test-2",
    ]);
  });

  test("stateful header mode sends only the newest message", async () => {
    __testSetBackend(fakeBackend());
    const messageCounts: number[] = [];
    stubTurn((_conversationId, _agentId, messages) => {
      messageCounts.push(messages.length);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-letta-chat-key": "pinned-chat",
      },
      body: JSON.stringify({
        model: "memo",
        messages: [
          { role: "user", content: "Hello" },
          { role: "assistant", content: "Hello world" },
          { role: "user", content: "follow-up" },
        ],
      }),
    });
    expect(messageCounts).toEqual([1]);
  });

  test("Idempotency-Key replays the original outcome without re-running", async () => {
    __testSetBackend(fakeBackend());
    let runs = 0;
    __testSetRunTurnImpl(async ({ onAssistantText }) => {
      runs += 1;
      onAssistantText?.("Hello world");
      return {
        text: "Hello world",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        error: null,
      };
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = (key: string) =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
        },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    const first = (await (await send("retry-1")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    const replay = (await (await send("retry-1")).json()) as {
      choices: Array<{ message: { content: string } }>;
    };
    await send("retry-2");

    expect(first.choices[0]?.message.content).toBe("Hello world");
    expect(replay.choices[0]?.message.content).toBe("Hello world");
    expect(runs).toBe(2);
  });

  test("failed idempotent outcomes are evicted so retries re-run", async () => {
    __testSetBackend(fakeBackend());
    let runs = 0;
    __testSetRunTurnImpl(async () => {
      runs += 1;
      return {
        text: "",
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        error: runs === 1 ? "transient failure" : null,
      };
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = () =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "retry-after-error",
        },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    expect((await send()).status).toBe(500);
    expect((await send()).status).toBe(200);
    expect(runs).toBe(2);
  });

  test("idempotent replays allocate no conversation", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    stubTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const send = () =>
      fetch(httpUrl(handle as AppServerHandle, "/v1/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "alloc-check",
        },
        body: JSON.stringify({
          model: "memo",
          messages: [{ role: "user", content: "hi" }],
        }),
      });

    await send();
    expect(created.length).toBe(1);
    await send();
    // The replay consulted the cache before allocating anything.
    expect(created.length).toBe(1);
  });

  test("headerless conversations are deleted after the turn settles", async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    __testSetBackend(fakeBackend(created, deleted));
    stubTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "memo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(await waitFor(() => deleted.includes("conv-test-1"))).toBe(true);

    // Header-keyed conversations persist: they ARE the chat's state.
    await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-letta-chat-key": "sticky-chat",
      },
      body: JSON.stringify({
        model: "memo",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deleted).toEqual(["conv-test-1"]);
  });

  test("image_url parts pass through as Letta image content", async () => {
    __testSetBackend(fakeBackend());
    let capturedContent: unknown = null;
    __testSetRunTurnImpl(async ({ messages, onAssistantText }) => {
      capturedContent = (messages[0] as { content: unknown }).content;
      onAssistantText?.("I see it");
      return {
        text: "I see it",
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        error: null,
      };
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
          {
            role: "user",
            content: [
              { type: "text", text: "what is in this image?" },
              {
                type: "image_url",
                image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
              },
            ],
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(capturedContent).toEqual([
      { type: "text", text: "what is in this image?" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ]);
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
