import { afterEach, describe, expect, test } from "bun:test";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import {
  __testResetConversationMap,
  __testSetRunTurnImpl,
} from "@/websocket/app-server-openai";

const TEST_AGENT = {
  id: "agent-local-heartbeat",
  name: "Heartbeat Agent",
  created_at: "2026-01-01T00:00:00Z",
};

function fakeBackend(): Backend {
  return {
    listAgents: async () => [TEST_AGENT],
    createConversation: async () => ({
      id: "conversation-heartbeat",
      agent_id: TEST_AGENT.id,
    }),
    deleteConversation: async () => ({}),
  } as unknown as Backend;
}

function httpUrl(handle: AppServerHandle, pathname: string): string {
  const url = new URL(handle.url);
  url.protocol = "http:";
  return `${url.origin}${pathname}`;
}

function stubSlowTurn(): void {
  __testSetRunTurnImpl(async ({ onAssistantText }) => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    onAssistantText?.("done");
    return {
      text: "done",
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      error: null,
    };
  });
}

async function readUntilHeartbeat(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Expected a streaming response body");

  const decoder = new TextDecoder();
  let output = "";
  const timeout = setTimeout(() => {
    void reader.cancel();
  }, 1000);
  try {
    while (!output.includes(": keepalive\n\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    return output;
  } finally {
    clearTimeout(timeout);
    await reader.cancel();
  }
}

describe("OpenAI-compatible SSE heartbeat", () => {
  let handle: AppServerHandle | null = null;

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    __testSetRunTurnImpl(null);
    __testResetConversationMap();
    __testSetBackend(null);
  });

  test("keeps a quiet chat-completions stream alive", async () => {
    __testSetBackend(fakeBackend());
    stubSlowTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
      openaiSseHeartbeatIntervalMs: 10,
      initializeRuntime: async () => {},
    });

    const response = await fetch(httpUrl(handle, "/v1/chat/completions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: TEST_AGENT.name,
        messages: [{ role: "user", content: "wait" }],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(await readUntilHeartbeat(response)).toContain(": keepalive\n\n");
  });

  test("keeps a quiet Responses stream alive", async () => {
    __testSetBackend(fakeBackend());
    stubSlowTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
      openaiSseHeartbeatIntervalMs: 10,
      initializeRuntime: async () => {},
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: TEST_AGENT.name,
        input: "wait",
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(await readUntilHeartbeat(response)).toContain(": keepalive\n\n");
  });
});
