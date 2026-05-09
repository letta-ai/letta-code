import { describe, expect, test } from "bun:test";
import type {
  LanguageModel,
  TextStreamPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import {
  AISDKStreamAdapter,
  type AISDKStreamTextFunction,
  buildAISDKProviderOptions,
} from "../../backend/dev/AISDKStreamAdapter";
import type { LocalAgentRecord } from "../../backend/dev/FakeHeadlessStore";
import type { HeadlessTurnBody } from "../../backend/dev/HeadlessTurnExecutor";
import type { ProviderTurnInput } from "../../backend/dev/ProviderTurnExecutor";
import type { LocalMessage } from "../../backend/local/LocalMessage";

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

type MockUIMessageStreamOptions = Parameters<
  NonNullable<ReturnType<AISDKStreamTextFunction>["toUIMessageStream"]>
>[0];

function uiMessageStreamWithFinish(
  chunks: Array<Record<string, unknown>>,
  responseMessage:
    | LocalMessage
    | ((options: MockUIMessageStreamOptions | undefined) => LocalMessage),
  finishReason: unknown = "stop",
) {
  return (options?: MockUIMessageStreamOptions) => {
    const response =
      typeof responseMessage === "function"
        ? responseMessage(options)
        : responseMessage;
    const originalMessages = options?.originalMessages ?? [];
    const isContinuation = originalMessages.at(-1)?.id === response.id;
    void options?.onFinish?.({
      messages: isContinuation
        ? [...originalMessages.slice(0, -1), response]
        : [...originalMessages, response],
      responseMessage: response,
      isContinuation,
      isAborted: false,
      finishReason,
    });
    return uiMessageStream(chunks);
  };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) {
    values.push(value);
  }
  return values;
}

function providerInput(
  uiMessages: LocalMessage[],
  agent: LocalAgentRecord = {
    id: "agent-test",
    name: "Test Agent",
    description: null,
    system: "test system",
    tags: [],
    model: "dev/fake-headless",
    model_settings: {},
  },
): ProviderTurnInput {
  return {
    conversationId: "conv-test",
    agentId: "agent-test",
    agent,
    body: {} as HeadlessTurnBody,
    history: [],
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

describe("AISDKStreamAdapter", () => {
  test("streams AI SDK output through provider events", async () => {
    const model = {} as LanguageModel;
    let capturedModel: LanguageModel | undefined;
    let capturedSystem: string | undefined;
    let capturedMessages: unknown[] | undefined;
    let capturedTools: ToolSet | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedModel = options.model;
      capturedSystem = options.system;
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
        toUIMessageStream: uiMessageStreamWithFinish(
          [
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
          ],
          {
            id: "ui-assistant-1",
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
          "tool-calls",
        ),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => model,
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

    expect(capturedModel).toBe(model);
    expect(capturedSystem).toBe("test system");
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

  test("derives the AI SDK model from agent model settings when no override is provided", async () => {
    const originalProvider = process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
    const originalModel = process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
    process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER = "anthropic";
    process.env.LETTA_CODE_DEV_AI_SDK_MODEL = "claude-test-env";
    let capturedModel: LanguageModel | undefined;
    let capturedSystem: string | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedModel = options.model;
      capturedSystem = options.system;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    try {
      const adapter = new AISDKStreamAdapter({ streamText });
      await collect(
        adapter.stream(
          providerInput(
            [
              {
                id: "ui-user-1",
                role: "user",
                parts: [{ type: "text", text: "hello" }],
              },
            ],
            {
              id: "agent-test",
              name: "Test Agent",
              description: null,
              system: "agent system prompt",
              tags: [],
              model: "anthropic/claude-agent",
              model_settings: { provider_type: "anthropic" },
            },
          ),
        ),
      );
    } finally {
      if (originalProvider === undefined) {
        delete process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER;
      } else {
        process.env.LETTA_CODE_DEV_AI_SDK_PROVIDER = originalProvider;
      }
      if (originalModel === undefined) {
        delete process.env.LETTA_CODE_DEV_AI_SDK_MODEL;
      } else {
        process.env.LETTA_CODE_DEV_AI_SDK_MODEL = originalModel;
      }
    }

    expect(capturedModel).toMatchObject({
      provider: "anthropic.messages",
      modelId: "claude-agent",
    });
    expect(capturedSystem).toBe("agent system prompt");
  });

  test("sends ChatGPT OAuth system prompt as instructions, not system input", async () => {
    const model = {} as LanguageModel;
    let capturedSystem: string | undefined;
    let capturedProviderOptions: unknown;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedSystem = options.system;
      capturedProviderOptions = options.providerOptions;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => model,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "compiled Letta system prompt",
            tags: [],
            model: "chatgpt-plus-pro/gpt-5.5",
            model_settings: { provider_type: "chatgpt_oauth" },
          },
        ),
      ),
    );

    expect(capturedSystem).toBeUndefined();
    expect(capturedProviderOptions).toEqual({
      openai: {
        instructions: "compiled Letta system prompt",
        store: false,
        systemMessageMode: "remove",
      },
    });
  });

  test("passes provider reasoning options from local model settings", async () => {
    const model = {} as LanguageModel;
    let capturedProviderOptions: unknown;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedProviderOptions = options.providerOptions;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };

    const adapter = new AISDKStreamAdapter({
      createModel: () => model,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [{ type: "text", text: "think hard" }],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "openai/gpt-5.5",
            model_settings: {
              provider_type: "openai",
              reasoning: { reasoning_effort: "xhigh" },
              verbosity: "medium",
              parallel_tool_calls: true,
            },
          },
        ),
      ),
    );

    expect(capturedProviderOptions).toEqual({
      openai: {
        reasoningEffort: "xhigh",
        textVerbosity: "medium",
        parallelToolCalls: true,
      },
    });
  });

  test("maps Claude 4.6 Anthropic thinking settings to adaptive AI SDK provider options", () => {
    expect(
      buildAISDKProviderOptions("anthropic/claude-sonnet-4-6", {
        provider_type: "anthropic",
        effort: "max",
        thinking: { type: "enabled", budget_tokens: 12000 },
      }),
    ).toEqual({
      anthropic: {
        effort: "max",
        thinking: { type: "adaptive" },
      },
    });
  });

  test("does not apply OpenAI provider options to OpenAI-compatible local providers", () => {
    expect(
      buildAISDKProviderOptions("openrouter/deepseek/deepseek-v4-pro", {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
        verbosity: "medium",
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("zai/glm-5.1", {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("moonshot/kimi-k2.5", {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("minimax/MiniMax-M2.7", {
        provider_type: "anthropic",
        effort: "high",
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("google_ai/gemini-3.1-pro-preview", {
        provider_type: "google_ai",
        thinking_config: { thinking_budget: 1024 },
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("bedrock/us.anthropic.claude-sonnet-4-6", {
        provider_type: "bedrock",
        effort: "high",
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("ollama/llama2", {
        provider_type: "openai",
        reasoning: { reasoning_effort: "high" },
      }),
    ).toBeUndefined();

    expect(
      buildAISDKProviderOptions("lmstudio/google/gemma-3n-e4b", {
        provider_type: "openai",
        verbosity: "medium",
      }),
    ).toBeUndefined();
  });

  test("moves the local system prompt to instructions for ChatGPT OAuth models", () => {
    expect(
      buildAISDKProviderOptions(
        "chatgpt-plus-pro/gpt-5.5",
        {
          provider_type: "chatgpt_oauth",
          reasoning_effort: "high",
          verbosity: "low",
        },
        { systemPrompt: "compiled Letta system prompt" },
      ),
    ).toEqual({
      openai: {
        instructions: "compiled Letta system prompt",
        store: false,
        systemMessageMode: "remove",
        reasoningEffort: "high",
        textVerbosity: "low",
      },
    });
  });

  test("maps Claude 4.7 thinking to adaptive summarized output", () => {
    expect(
      buildAISDKProviderOptions("anthropic/claude-opus-4-7", {
        provider_type: "anthropic",
        effort: "xhigh",
        thinking: { type: "enabled", budget_tokens: 12000 },
      }),
    ).toEqual({
      anthropic: {
        effort: "xhigh",
        thinking: { type: "adaptive", display: "summarized" },
      },
    });
  });

  test("keeps manual Anthropic thinking budgets for legacy Claude 4.5", () => {
    expect(
      buildAISDKProviderOptions("anthropic/claude-opus-4-5-20251101", {
        provider_type: "anthropic",
        effort: "high",
        thinking: { type: "enabled", budget_tokens: 12000 },
      }),
    ).toEqual({
      anthropic: {
        effort: "high",
        thinking: { type: "enabled", budgetTokens: 12000 },
      },
    });
  });

  test("drops cross-provider reasoning parts before OpenAI conversion", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
            {
              id: "ui-assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "reasoning",
                  text: "anthropic reasoning",
                  providerMetadata: { anthropic: { signature: "sig" } },
                },
                {
                  type: "reasoning",
                  text: "openai reasoning",
                  providerMetadata: {
                    openai: { itemId: "rs_1", reasoningEncryptedContent: null },
                  },
                },
                { type: "text", text: "answer" },
              ],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "openai/gpt-5.5",
            model_settings: { provider_type: "openai" },
          },
        ),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).not.toContain("anthropic reasoning");
    expect(serialized).toContain("openai reasoning");
  });

  test("drops Anthropic providerOptions reasoning parts before OpenAI conversion", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
            {
              id: "ui-assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "reasoning",
                  text: "anthropic providerOptions reasoning",
                  providerOptions: { anthropic: { signature: "sig" } },
                } as unknown as LocalMessage["parts"][number],
                { type: "text", text: "answer" },
              ],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "openai/gpt-5.5",
            model_settings: { provider_type: "openai" },
          },
        ),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).not.toContain("anthropic providerOptions reasoning");
    expect(serialized).toContain("answer");
  });

  test("drops cross-provider reasoning parts before Anthropic conversion", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [{ type: "text", text: "hello" }],
            },
            {
              id: "ui-assistant-1",
              role: "assistant",
              parts: [
                {
                  type: "reasoning",
                  text: "anthropic reasoning",
                  providerMetadata: { anthropic: { signature: "sig" } },
                },
                {
                  type: "reasoning",
                  text: "openai reasoning",
                  providerMetadata: {
                    openai: { itemId: "rs_1", reasoningEncryptedContent: null },
                  },
                },
                { type: "text", text: "answer" },
              ],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "anthropic/claude-sonnet-4-6",
            model_settings: { provider_type: "anthropic", effort: "high" },
          },
        ),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain("anthropic reasoning");
    expect(serialized).not.toContain("openai reasoning");
  });

  test("replaces unsupported image file parts with explicit text before AI SDK conversion", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [
                { type: "text", text: "what is in this screenshot?" },
                {
                  type: "file",
                  mediaType: "image/png",
                  url: "data:image/png;base64,aGVsbG8=",
                  filename: "screenshot.png",
                },
              ],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "ollama/llama2",
            model_settings: { provider_type: "ollama" },
          },
        ),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain(
      'ERROR: Cannot read \\"screenshot.png\\" (this model does not support image input). Inform the user.',
    );
    expect(serialized).not.toContain('"type":"file"');
    expect(serialized).not.toContain("data:image/png");
  });

  test("preserves image file parts when model modalities include image input", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput(
          [
            {
              id: "ui-user-1",
              role: "user",
              parts: [
                { type: "text", text: "what is in this screenshot?" },
                {
                  type: "file",
                  mediaType: "image/png",
                  url: "data:image/png;base64,aGVsbG8=",
                  filename: "screenshot.png",
                },
              ],
            },
          ],
          {
            id: "agent-test",
            name: "Test Agent",
            description: null,
            system: "agent system prompt",
            tags: [],
            model: "ollama/llama2",
            model_settings: {
              provider_type: "ollama",
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        ),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain('"type":"file"');
    expect(serialized).toContain("data:image/png;base64,aGVsbG8=");
    expect(serialized).not.toContain("this model does not support image input");
  });

  test("turns empty legacy image data URLs into an explicit user-visible error", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
      capturedMessages = options.messages;
      return {
        fullStream: (async function* () {
          yield streamPart({ type: "finish", finishReason: "stop" });
        })(),
      };
    };
    const adapter = new AISDKStreamAdapter({
      createModel: () => ({}) as LanguageModel,
      streamText,
    });

    await collect(
      adapter.stream(
        providerInput([
          {
            id: "ui-user-1",
            role: "user",
            parts: [
              {
                type: "image",
                image: "data:image/png;base64,",
              } as unknown as LocalMessage["parts"][number],
            ],
          },
        ]),
      ),
    );

    const serialized = JSON.stringify(capturedMessages);
    expect(serialized).toContain(
      "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    );
  });

  test("projects UI tool outputs without AI SDK approval protocol parts", async () => {
    let capturedMessages: unknown[] | undefined;
    const streamText: AISDKStreamTextFunction = (options) => {
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
    const adapter = new AISDKStreamAdapter({
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
