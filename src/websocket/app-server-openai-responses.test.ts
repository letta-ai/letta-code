import { afterEach, describe, expect, test } from "bun:test";
import OpenAI from "openai";
import type { Backend } from "@/backend";
import { __testSetBackend } from "@/backend";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import {
  __testResetConversationMap,
  __testSetRunTurnImpl,
} from "@/websocket/app-server-openai";

const TEST_AGENT = {
  id: "agent-local-tutor",
  name: "Tutor (Letta Agent)",
  created_at: "2026-01-01T00:00:00Z",
};

function fakeBackend(created: string[] = [], deleted: string[] = []): Backend {
  return {
    listAgents: async () => [TEST_AGENT],
    createConversation: async () => {
      const id = `conv-responses-${created.length + 1}`;
      created.push(id);
      return { id, agent_id: TEST_AGENT.id };
    },
    deleteConversation: async (conversationId: string) => {
      deleted.push(conversationId);
      return {};
    },
  } as unknown as Backend;
}

function httpUrl(handle: AppServerHandle, path: string): string {
  const url = new URL(handle.url);
  url.protocol = "http:";
  return `${url.origin}${path}`;
}

function stubToolTurn(
  capture?: (conversationId: string, messages: unknown[]) => void,
): void {
  __testSetRunTurnImpl(
    async ({ conversationId, messages, onAssistantText, onToolEvent }) => {
      capture?.(conversationId, messages);
      onToolEvent?.({
        type: "tool_call_start",
        tool_call_id: "call_bash_1",
        tool_name: "Bash",
      });
      onToolEvent?.({
        type: "tool_call_arguments_delta",
        tool_call_id: "call_bash_1",
        arguments_delta: '{"command":"pwd"}',
      });
      onToolEvent?.({
        type: "tool_call_complete",
        tool_call_id: "call_bash_1",
        tool_name: "Bash",
        arguments: '{"command":"pwd"}',
        output: "/workspace/letta-code\n",
        success: true,
      });
      onAssistantText?.("I examined ");
      onAssistantText?.("the project.");
      return {
        text: "I examined the project.",
        usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
        error: null,
      };
    },
  );
}

describe("app-server Responses API", () => {
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

  test("POST /v1/responses returns completed server-side tool traces", async () => {
    const deleted: string[] = [];
    __testSetBackend(fakeBackend([], deleted));
    stubToolTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: "Examine the current directory.",
        store: false,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      id: string;
      object: string;
      status: string;
      output: Array<Record<string, unknown>>;
      usage: Record<string, number>;
    };
    expect(body.id).toStartWith("resp_");
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.output).toHaveLength(3);
    expect(body.output[0]).toMatchObject({
      type: "function_call",
      call_id: "call_bash_1",
      name: "Bash",
      arguments: '{"command":"pwd"}',
      status: "completed",
    });
    expect(body.output[1]).toMatchObject({
      type: "function_call_output",
      call_id: "call_bash_1",
      status: "completed",
      output: [{ type: "input_text", text: "/workspace/letta-code\n" }],
    });
    expect(body.output[2]).toMatchObject({
      type: "message",
      status: "completed",
      role: "assistant",
      content: [
        {
          type: "output_text",
          text: "I examined the project.",
          annotations: [],
        },
      ],
    });
    expect(body.usage).toEqual({
      input_tokens: 21,
      output_tokens: 9,
      total_tokens: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(deleted).toEqual(["conv-responses-1"]);
  });

  test("POST /v1/responses streams spec-native tool and text events", async () => {
    __testSetBackend(fakeBackend());
    stubToolTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Inspect the repo." }],
          },
        ],
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const stream = await response.text();
    const events = stream
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    expect(events.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.function_call_arguments.delta",
      "response.function_call_arguments.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_, index) => index),
    );
    const completed = events.at(-1)?.response as {
      status: string;
      output: Array<Record<string, unknown>>;
    };
    expect(completed.status).toBe("completed");
    expect(completed.output[1]?.type).toBe("function_call_output");
    expect(completed.output[2]?.type).toBe("message");
  });

  test("preserves assistant text ordering around a server-side tool call", async () => {
    __testSetBackend(fakeBackend());
    __testSetRunTurnImpl(async ({ onAssistantText, onToolEvent }) => {
      onAssistantText?.("Let me check that.");
      onToolEvent?.({
        type: "tool_call_start",
        tool_call_id: "call_ordered",
        tool_name: "Bash",
      });
      onToolEvent?.({
        type: "tool_call_arguments_delta",
        tool_call_id: "call_ordered",
        arguments_delta: '{"command":"pwd"}',
      });
      onToolEvent?.({
        type: "tool_call_complete",
        tool_call_id: "call_ordered",
        tool_name: "Bash",
        arguments: '{"command":"pwd"}',
        output: "/workspace",
        success: true,
      });
      onAssistantText?.("The directory is /workspace.");
      return {
        text: "Let me check that.The directory is /workspace.",
        usage: { prompt_tokens: 4, completion_tokens: 8, total_tokens: 12 },
        error: null,
      };
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: "Where are you running?",
      }),
    });
    const body = (await response.json()) as {
      output: Array<{
        type: string;
        content?: Array<{ text?: string }>;
      }>;
    };

    expect(body.output.map((item) => item.type)).toEqual([
      "message",
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(body.output[0]?.content?.[0]?.text).toBe("Let me check that.");
    expect(body.output[3]?.content?.[0]?.text).toBe(
      "The directory is /workspace.",
    );
  });

  test("works through the official OpenAI Responses SDK", async () => {
    __testSetBackend(fakeBackend());
    stubToolTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });
    const client = new OpenAI({
      apiKey: "not-needed",
      baseURL: httpUrl(handle, "/v1"),
    });

    const result = await client.responses.create({
      model: "Tutor (Letta Agent)",
      input: "Inspect the repo.",
    });

    expect(result.status).toBe("completed");
    expect(result.output.map((item) => item.type)).toEqual([
      "function_call",
      "function_call_output",
      "message",
    ]);
    expect(result.output_text).toBe("I examined the project.");
  });

  test("store plus previous_response_id continues the same conversation", async () => {
    const created: string[] = [];
    __testSetBackend(fakeBackend(created));
    const conversations: string[] = [];
    const messageCounts: number[] = [];
    stubToolTurn((conversationId, messages) => {
      conversations.push(conversationId);
      messageCounts.push(messages.length);
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const first = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: "Learn this project.",
      }),
    });
    const firstBody = (await first.json()) as { id: string };

    const second = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: "What did you learn?",
        previous_response_id: firstBody.id,
      }),
    });

    expect(second.status).toBe(200);
    expect(created).toEqual(["conv-responses-1"]);
    expect(conversations).toEqual(["conv-responses-1", "conv-responses-1"]);
    expect(messageCounts).toEqual([1, 1]);
  });

  test("Open WebUI chat ids isolate sessions and continue messages", async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    __testSetBackend(fakeBackend(created, deleted));
    const turns: Array<{
      conversationId: string;
      messages: unknown[];
    }> = [];
    stubToolTurn((conversationId, messages) => {
      turns.push({ conversationId, messages });
    });
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });
    const server = handle;

    const sendOpenWebUiMessage = async (
      chatId: string,
      input: unknown,
      stream = true,
    ): Promise<number> => {
      const response = await fetch(httpUrl(server, "/v1/responses"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-openwebui-chat-id": chatId,
        },
        body: JSON.stringify({
          model: "Tutor (Letta Agent)",
          input,
          stream,
        }),
      });
      await response.text();
      return response.status;
    };

    expect(await sendOpenWebUiMessage("chat-a", "first message")).toBe(200);
    expect(
      await sendOpenWebUiMessage("chat-a", "generate a title", false),
    ).toBe(200);
    expect(
      await sendOpenWebUiMessage("chat-a", [
        { type: "message", role: "user", content: "first message" },
        { type: "message", role: "assistant", content: "first reply" },
        { type: "message", role: "user", content: "second message" },
      ]),
    ).toBe(200);
    expect(await sendOpenWebUiMessage("chat-b", "separate chat")).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(created).toEqual([
      "conv-responses-1",
      "conv-responses-2",
      "conv-responses-3",
    ]);
    expect(deleted).toEqual(["conv-responses-2"]);
    expect(turns.map((turn) => turn.conversationId)).toEqual([
      "conv-responses-1",
      "conv-responses-2",
      "conv-responses-1",
      "conv-responses-3",
    ]);
    expect(turns.map((turn) => turn.messages)).toMatchObject([
      [{ role: "user", content: [{ type: "text", text: "first message" }] }],
      [{ role: "user", content: [{ type: "text", text: "generate a title" }] }],
      [{ role: "user", content: [{ type: "text", text: "second message" }] }],
      [{ role: "user", content: [{ type: "text", text: "separate chat" }] }],
    ]);
  });

  test("rejects unknown previous_response_id", async () => {
    __testSetBackend(fakeBackend());
    stubToolTurn();
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "Tutor (Letta Agent)",
        input: "Hello",
        previous_response_id: "resp_missing",
      }),
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("previous_response_not_found");
  });

  test("requires user input", async () => {
    __testSetBackend(fakeBackend());
    handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      openaiApi: true,
    });

    const response = await fetch(httpUrl(handle, "/v1/responses"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "Tutor (Letta Agent)", input: [] }),
    });
    expect(response.status).toBe(400);
  });
});
