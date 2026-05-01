import { describe, expect, test } from "bun:test";
import type {
  LanguageModel,
  TextStreamPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import type { HeadlessTurnBody } from "../../backend/dev/HeadlessTurnExecutor";
import {
  OpenAIResponsesStreamAdapter,
  type OpenAIResponsesStreamAdapterOptions,
} from "../../backend/dev/OpenAIResponsesStreamAdapter";
import type { ProviderTrajectoryUIMessage } from "../../backend/dev/ProviderTrajectory";
import type { ProviderTurnInput } from "../../backend/dev/ProviderTurnExecutor";

function streamPart(part: Record<string, unknown>): TextStreamPart<ToolSet> {
  return part as unknown as TextStreamPart<ToolSet>;
}

function uiMessageStream(chunks: Array<Record<string, unknown>>) {
  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk as UIMessageChunk);
      }
      controller.close();
    },
  });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function providerInput(
  uiMessages: ProviderTrajectoryUIMessage[],
): ProviderTurnInput {
  return {
    conversationId: "conv-test",
    agentId: "agent-test",
    body: {} as HeadlessTurnBody,
    history: [],
    providerTrajectory: [],
    uiMessages,
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
          yield streamPart({
            type: "reasoning-delta",
            id: "reasoning-1",
            text: "thinking",
          });
          yield streamPart({ type: "text-delta", id: "text-1", text: "hi" });
          yield streamPart({
            type: "tool-call",
            toolCallId: "call-2",
            toolName: "ShellCommand",
            input: { command: "pwd" },
          });
          yield streamPart({ type: "finish", finishReason: "tool-calls" });
        })(),
        toUIMessageStream: () =>
          uiMessageStream([
            { type: "start" },
            { type: "reasoning-start", id: "reasoning-1" },
            {
              type: "reasoning-delta",
              id: "reasoning-1",
              delta: "thinking",
            },
            { type: "reasoning-end", id: "reasoning-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "hi" },
            { type: "text-end", id: "text-1" },
            {
              type: "tool-input-available",
              toolCallId: "call-2",
              toolName: "ShellCommand",
              input: { command: "pwd" },
            },
            { type: "finish", finishReason: "tool-calls" },
          ]),
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
          {
            id: "ui-user-1",
            role: "user",
            parts: [{ type: "text", text: "canonical hello" }],
          },
        ]),
      ),
    );

    expect(capturedModel).toBe("gpt-test");
    expect(capturedMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "canonical hello" }],
      },
    ]);
    expect(Object.keys(capturedTools ?? {})).toEqual(["ShellCommand"]);
    expect(events.map((event) => event.type)).toEqual([
      "ai-sdk-part",
      "ai-sdk-part",
      "ai-sdk-part",
      "ai-sdk-part",
      "ai-sdk-ui-message",
    ]);
    expect(
      events.map((event) => event.type === "ai-sdk-part" && event.part.type),
    ).toEqual(["reasoning-delta", "text-delta", "tool-call", "finish", false]);
    expect(events.at(-1)).toMatchObject({
      type: "ai-sdk-ui-message",
      message: {
        role: "assistant",
        parts: [
          { type: "reasoning", text: "thinking", state: "done" },
          { type: "text", text: "hi", state: "done" },
          {
            type: "tool-ShellCommand",
            toolCallId: "call-2",
            state: "input-available",
            input: { command: "pwd" },
          },
        ],
      },
    });
  });

  test("projects UI tool outputs without AI SDK approval protocol parts", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: NonNullable<
      OpenAIResponsesStreamAdapterOptions["streamText"]
    > = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
        toUIMessageStream: () =>
          uiMessageStream([
            { type: "start" },
            { type: "finish", finishReason: "stop" },
          ]),
      };
    };
    const adapter = new OpenAIResponsesStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput([
          {
            id: "ui-user-1",
            role: "user",
            parts: [{ type: "text", text: "call tool" }],
          },
          {
            id: "ui-assistant-1",
            role: "assistant",
            parts: [
              {
                type: "tool-ShellCommand",
                toolCallId: "call-1",
                state: "output-available",
                input: { command: "pwd" },
                output: "ok",
              },
            ],
          },
        ]),
      ),
    );

    expect(capturedMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "call tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "ShellCommand",
            input: { command: "pwd" },
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
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ]);
  });
});
