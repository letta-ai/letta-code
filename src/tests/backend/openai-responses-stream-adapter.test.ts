import { describe, expect, test } from "bun:test";
import type { LanguageModel, TextStreamPart, ToolSet } from "ai";
import type { StoredMessage } from "../../backend/dev/FakeHeadlessStore";
import type { HeadlessTurnBody } from "../../backend/dev/HeadlessTurnExecutor";
import {
  OpenAIResponsesStreamAdapter,
  type OpenAIResponsesStreamAdapterOptions,
  storedMessagesToModelMessages,
} from "../../backend/dev/OpenAIResponsesStreamAdapter";
import type { ProviderTurnInput } from "../../backend/dev/ProviderTurnExecutor";

function stored(
  fields: Partial<StoredMessage> & { message_type: string } & Record<
      string,
      unknown
    >,
) {
  return {
    id: "msg-test",
    date: "2026-01-01T00:00:00.000Z",
    agent_id: "agent-test",
    conversation_id: "conv-test",
    ...fields,
  } as StoredMessage;
}

function streamPart(part: Record<string, unknown>): TextStreamPart<ToolSet> {
  return part as unknown as TextStreamPart<ToolSet>;
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function providerInput(history: StoredMessage[]): ProviderTurnInput {
  return {
    conversationId: "conv-test",
    agentId: "agent-test",
    body: {} as HeadlessTurnBody,
    history,
    clientTools: [
      {
        name: "ShellCommand",
        description: "Run a shell command",
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
      },
    ],
    clientSkills: [],
  };
}

describe("OpenAIResponsesStreamAdapter", () => {
  test("converts stored fake-backend messages into AI SDK model messages", () => {
    const messages = storedMessagesToModelMessages([
      stored({
        message_type: "user_message",
        content: [{ type: "text", text: "hello" }],
      }),
      stored({
        message_type: "assistant_message",
        content: [{ type: "text", text: "checking" }],
      }),
      stored({
        message_type: "approval_request_message",
        tool_call: {
          tool_call_id: "call-1",
          name: "ShellCommand",
          arguments: JSON.stringify({ command: "echo hi" }),
        },
      }),
      stored({
        message_type: "approval_response_message",
        approvals: [
          {
            type: "tool",
            tool_call_id: "call-1",
            tool_return: "hi",
            status: "success",
          },
        ],
      }),
      stored({
        message_type: "assistant_message",
        content: [{ type: "text", text: "done" }],
      }),
    ]);

    expect(messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "checking",
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "ShellCommand",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "ShellCommand",
            output: { type: "text", value: "hi" },
          },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
  });

  test("streams OpenAI Responses output through provider events", async () => {
    let capturedModel: string | undefined;
    let capturedMessages: unknown[] | undefined;
    let capturedTools: ToolSet | undefined;
    const streamText: NonNullable<
      OpenAIResponsesStreamAdapterOptions["streamText"]
    > = (options) => {
      capturedMessages = options.messages;
      capturedTools = options.tools;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "text-delta", id: "text-1", text: "hi" });
          yield streamPart({
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "ShellCommand",
            input: { command: "pwd" },
          });
          yield streamPart({ type: "finish", finishReason: "tool-calls" });
        })(),
      };
    };
    const adapter = new OpenAIResponsesStreamAdapter({
      model: "gpt-test",
      createModel: (model) => {
        capturedModel = model;
        return {} as LanguageModel;
      },
      streamText,
    });

    const events = await collect(
      adapter.stream(
        providerInput([
          stored({
            message_type: "user_message",
            content: [{ type: "text", text: "hello" }],
          }),
        ]),
      ),
    );

    expect(capturedModel).toBe("gpt-test");
    expect(capturedMessages).toEqual([{ role: "user", content: "hello" }]);
    expect(Object.keys(capturedTools ?? {})).toEqual(["ShellCommand"]);
    expect(events).toEqual([
      { type: "text-delta", text: "hi" },
      {
        type: "tool-call",
        toolCallId: "call-2",
        toolName: "ShellCommand",
        input: { command: "pwd" },
      },
      { type: "finish", finishReason: "tool-calls" },
    ]);
  });
});
