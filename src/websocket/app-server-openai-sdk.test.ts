import { afterEach, describe, expect, test } from "bun:test";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import OpenAI from "openai";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { parseAppServerWebsocketAuthSettings } from "@/websocket/app-server-auth";
import {
  __testResetConversationMap,
  __testSetSendMessageStreamImpl,
} from "@/websocket/app-server-openai";

// Conformance tests: drive the /v1 routes through the real OpenAI SDK
// instead of raw fetch, proving an unmodified OpenAI client round-trips
// against the App Server. Wire-format assertions live in
// app-server-openai.test.ts; these assert client-level compatibility.

const TEST_AGENTS = [
  { id: "agent-local-111", name: "memo" },
  { id: "agent-local-222", name: "patch" },
];

let conversationCounter = 0;

function fakeBackend(): Backend {
  return {
    listAgents: async () => TEST_AGENTS,
    createConversation: async (body: { agent_id: string }) => {
      conversationCounter += 1;
      return { id: `conv-sdk-${conversationCounter}`, agent_id: body.agent_id };
    },
  } as unknown as Backend;
}

function stubTurnStream(): void {
  const chunks = [
    { message_type: "assistant_message", content: "Hello " },
    { message_type: "assistant_message", content: "world" },
    {
      message_type: "usage_statistics",
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    },
    { message_type: "stop_reason", stop_reason: "end_turn" },
  ] as unknown as LettaStreamingResponse[];
  __testSetSendMessageStreamImpl(async () => {
    return (async function* () {
      for (const chunk of chunks) {
        yield chunk;
      }
    })();
  });
}

function sdkClient(handle: AppServerHandle, apiKey = "unused"): OpenAI {
  const url = new URL(handle.url);
  url.protocol = "http:";
  return new OpenAI({ baseURL: `${url.origin}/v1`, apiKey });
}

describe("app-server OpenAI SDK conformance", () => {
  let handle: AppServerHandle | null = null;

  afterEach(async () => {
    __testSetSendMessageStreamImpl(null);
    __testResetConversationMap();
    __testSetBackend(null);
    if (handle) {
      await handle.close();
      handle = null;
    }
  });

  test("models.list returns agents", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const models = await sdkClient(handle).models.list();
    const ids = models.data.map((model) => model.id);
    expect(ids).toEqual(["memo", "patch"]);
  });

  test("chat.completions.create round-trips (non-streaming)", async () => {
    __testSetBackend(fakeBackend());
    stubTurnStream();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const completion = await sdkClient(handle).chat.completions.create({
      model: "memo",
      messages: [{ role: "user", content: "say hello" }],
    });
    expect(completion.choices[0]?.message.content).toBe("Hello world");
    expect(completion.choices[0]?.finish_reason).toBe("stop");
    expect(completion.usage?.total_tokens).toBe(18);
  });

  test("chat.completions.create streams via the SDK", async () => {
    __testSetBackend(fakeBackend());
    stubTurnStream();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const stream = await sdkClient(handle).chat.completions.create({
      model: "patch",
      messages: [{ role: "user", content: "say hello" }],
      stream: true,
    });
    let text = "";
    let finishReason: string | null = null;
    for await (const chunk of stream) {
      text += chunk.choices[0]?.delta.content ?? "";
      finishReason = chunk.choices[0]?.finish_reason ?? finishReason;
    }
    expect(text).toBe("Hello world");
    expect(finishReason).toBe("stop");
  });

  test("SDK receives 401 as APIError with bad token", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
      websocketAuth: parseAppServerWebsocketAuthSettings({
        wsAuth: "capability-token",
        wsTokenSha256:
          "a7f6237e747a7a7d8ba94e0b8e64ba1c369b071b6f13905c0d55221b0a8b6a1c",
      }),
    });

    // Explicit try/catch rather than expect(...).rejects: the SDK's lazy
    // PagePromise thenable defers the request in a way bun's rejects
    // matcher does not observe.
    const client = sdkClient(handle, "wrong-token");
    let status: number | null = null;
    try {
      await client.models.list();
    } catch (error) {
      status = (error as { status?: number }).status ?? null;
    }
    expect(status).toBe(401);
  });
});
