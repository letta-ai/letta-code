import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  LlmStartInfo,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";
import {
  createOrUpdateLocalProvider,
  LOCAL_CHATGPT_PROVIDER_NAME,
  setLocalOAuthProvider,
} from "@/backend/local/local-provider-auth-store";

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-6",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantErrorMessage(errorMessage: string): AssistantMessage {
  return {
    ...assistantMessage(),
    content: [],
    stopReason: "error",
    errorMessage,
  };
}

function streamFromEvents(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), {
    result: async () => finalMessage,
  });
}

async function collectEvents(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const collected: ProviderStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function input(): ProviderTurnInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      model_settings: { provider_type: "bedrock" },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      { id: "ui-msg-1", role: "user", content: "hello", timestamp: Date.now() },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

function emptyTextBlocks(messages: Context["messages"]) {
  return messages.flatMap((message) => {
    const content = message.content;
    if (!Array.isArray(content)) return [];
    return content.filter(
      (part) => part.type === "text" && part.text.trim().length === 0,
    );
  });
}

describe("PiStreamAdapter", () => {
  test("routes clean provider overflow errors into compaction and retries", async () => {
    let providerCalls = 0;
    const stream: PiStreamFunction = () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        const error = assistantErrorMessage(
          "prompt is too long: 500000 tokens > 272000 maximum",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    let overflowError: unknown;
    const adapter = new PiStreamAdapter({
      stream,
      onContextWindowOverflow: async (_input, error) => {
        overflowError = error;
        return {
          uiMessages: [
            {
              id: "ui-msg-compacted",
              role: "user",
              content: "small",
              timestamp: Date.now(),
            },
          ],
          summary: "compacted old context",
        };
      },
    });
    const events = await collectEvents(adapter.stream(input()));

    expect(providerCalls).toBe(2);
    expect(String(overflowError)).toContain("prompt is too long");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "letta-chunk",
        chunk: expect.objectContaining({
          message_type: "event_message",
          event_type: "compaction",
        }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "letta-chunk",
        chunk: expect.objectContaining({
          message_type: "summary_message",
          summary: "compacted old context",
        }),
      }),
    );
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("elides image payloads in-memory before retrying oversized transport failures", async () => {
    let providerCalls = 0;
    const contexts: Context[] = [];
    const stream: PiStreamFunction = (_model, context) => {
      providerCalls += 1;
      contexts.push(context);
      if (providerCalls === 1) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({
      stream,
      onContextWindowOverflow: async () => {
        throw new Error("Compaction should not run before image elision");
      },
    });
    const baseInput = input();
    const events = await collectEvents(
      adapter.stream({
        ...baseInput,
        // Semantic image cost is tiny (1200 tokens), but the raw base64 body is
        // oversized. After a real transport failure, retry with provider-only
        // image elision instead of persisting a compaction that may not shed the
        // kept image bytes.
        uiMessages: [
          {
            id: "ui-msg-large-image",
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "a".repeat(8_000_001),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      }),
    );

    expect(providerCalls).toBe(2);
    expect(contexts[0]?.messages[0]?.content).toEqual([
      {
        type: "image",
        mimeType: "image/png",
        data: "a".repeat(8_000_001),
      },
    ]);
    expect(contexts[1]?.messages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Image omitted"),
      }),
    ]);
    const retryEvents = events.filter(
      (event) =>
        event.type === "letta-chunk" &&
        (event.chunk as { event_type?: string }).event_type === "retry",
    );
    expect(retryEvents).toHaveLength(0);
    const imageElisionEvents = events.filter(
      (event) =>
        event.type === "letta-chunk" &&
        (event.chunk as { event_type?: string }).event_type ===
          "context_image_elision",
    );
    expect(imageElisionEvents).toHaveLength(0);
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("honors LETTA_LOCAL_REQUEST_BYTE_LIMIT for image elision threshold", async () => {
    const previousLimit = process.env.LETTA_LOCAL_REQUEST_BYTE_LIMIT;
    process.env.LETTA_LOCAL_REQUEST_BYTE_LIMIT = "3000000";
    try {
      let providerCalls = 0;
      const contexts: Context[] = [];
      const stream: PiStreamFunction = (_model, context) => {
        providerCalls += 1;
        contexts.push(context);
        if (providerCalls === 1) {
          const error = assistantErrorMessage(
            "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
          );
          return streamFromEvents(
            [{ type: "error", reason: "error", error }],
            error,
          );
        }
        const finalMessage = assistantMessage();
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: finalMessage }],
          finalMessage,
        );
      };

      const adapter = new PiStreamAdapter({
        stream,
        onContextWindowOverflow: async () => {
          throw new Error("Compaction should not run before image elision");
        },
      });
      const baseInput = input();
      const events = await collectEvents(
        adapter.stream({
          ...baseInput,
          uiMessages: [
            {
              id: "ui-msg-env-threshold-image",
              role: "user",
              content: [
                {
                  type: "image",
                  mimeType: "image/png",
                  data: "a".repeat(3_000_001),
                },
              ],
              timestamp: Date.now(),
            },
          ],
        }),
      );

      expect(providerCalls).toBe(2);
      expect(contexts[1]?.messages[0]?.content).toEqual([
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("Image omitted"),
        }),
      ]);
      const imageElisionEvents = events.filter(
        (event) =>
          event.type === "letta-chunk" &&
          (event.chunk as { event_type?: string }).event_type ===
            "context_image_elision",
      );
      expect(imageElisionEvents).toHaveLength(0);
    } finally {
      if (previousLimit === undefined) {
        delete process.env.LETTA_LOCAL_REQUEST_BYTE_LIMIT;
      } else {
        process.env.LETTA_LOCAL_REQUEST_BYTE_LIMIT = previousLimit;
      }
    }
  });

  test("adaptively elides images after repeated transport failures below byte limit", async () => {
    let providerCalls = 0;
    const contexts: Context[] = [];
    const stream: PiStreamFunction = (_model, context) => {
      providerCalls += 1;
      contexts.push(context);
      if (providerCalls <= 3) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({ stream });
    const baseInput = input();
    const events = await collectEvents(
      adapter.stream({
        ...baseInput,
        uiMessages: [
          {
            id: "ui-msg-under-limit-image",
            role: "user",
            content: [
              {
                type: "image",
                mimeType: "image/png",
                data: "a".repeat(3_000_001),
              },
            ],
            timestamp: Date.now(),
          },
        ],
      }),
    );

    expect(providerCalls).toBe(4);
    expect(
      contexts.slice(0, 3).map((context) => context.messages[0]?.content),
    ).toEqual([
      [expect.objectContaining({ type: "image" })],
      [expect.objectContaining({ type: "image" })],
      [expect.objectContaining({ type: "image" })],
    ]);
    expect(contexts[3]?.messages[0]?.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Image omitted"),
      }),
    ]);
    const retryEvents = events.filter(
      (event) =>
        event.type === "letta-chunk" &&
        (event.chunk as { event_type?: string }).event_type === "retry",
    );
    expect(retryEvents).toHaveLength(2);
    const imageElisionEvents = events.filter(
      (event) =>
        event.type === "letta-chunk" &&
        (event.chunk as { event_type?: string }).event_type ===
          "context_image_elision",
    );
    expect(imageElisionEvents).toHaveLength(0);
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("classifies non-image oversized transport failures as overflow instead of retrying", async () => {
    let providerCalls = 0;
    const stream: PiStreamFunction = () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    let overflowError: unknown;
    const adapter = new PiStreamAdapter({
      stream,
      onContextWindowOverflow: async (_input, error) => {
        overflowError = error;
        return {
          uiMessages: [
            {
              id: "ui-msg-compacted",
              role: "user",
              content: "small",
              timestamp: Date.now(),
            },
          ],
          summary: "compacted oversized text",
        };
      },
    });
    const baseInput = input();
    const events = await collectEvents(
      adapter.stream({
        ...baseInput,
        uiMessages: [
          {
            id: "ui-msg-large-text",
            role: "user",
            content: "x".repeat(8_000_001),
            timestamp: Date.now(),
          },
        ],
      }),
    );

    expect(providerCalls).toBe(2);
    expect(String(overflowError)).toContain("WebSocket closed 1006");
    const retryEvents = events.filter(
      (event) =>
        event.type === "letta-chunk" &&
        (event.chunk as { event_type?: string }).event_type === "retry",
    );
    expect(retryEvents).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "letta-chunk",
        chunk: expect.objectContaining({
          message_type: "event_message",
          event_type: "compaction",
        }),
      }),
    );
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("falls back to transient retry when oversized-payload compaction fails", async () => {
    let providerCalls = 0;
    const stream: PiStreamFunction = () => {
      providerCalls += 1;
      if (providerCalls === 1) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({
      stream,
      onContextWindowOverflow: async () => {
        // Simulates a summarizer failure (for example the summarization model
        // call being rejected by the provider).
        throw new Error("Local compaction failed");
      },
    });
    const baseInput = input();
    const events = await collectEvents(
      adapter.stream({
        ...baseInput,
        uiMessages: [
          {
            id: "ui-msg-large-text",
            role: "user",
            content: "x".repeat(8_000_001),
            timestamp: Date.now(),
          },
        ],
      }),
    );

    // The retryable transport error must win over the compaction failure:
    // the turn retries and completes instead of surfacing the summarizer
    // error as a non-retryable run failure.
    expect(providerCalls).toBe(2);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "letta-chunk",
        chunk: expect.objectContaining({
          message_type: "event_message",
          event_type: "retry",
        }),
      }),
    );
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("removes OpenAI Responses replay item IDs before provider submission", async () => {
    let sanitizedPayload: unknown;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      _context: Context,
      options?: SimpleStreamOptions & Record<string, unknown>,
    ) => {
      const payload = {
        model: "gpt-5.5",
        input: [
          {
            type: "reasoning",
            id: "rs_0052fa548fed1375016a0e8d5da1cc819bbbf26f40ef48320c",
            encrypted_content: "opaque",
          },
          {
            type: "message",
            id: "msg_0052fa548fed1375016a0e8d5da1cc819bbbf26f40ef48320c",
            role: "assistant",
            content: [{ type: "output_text", text: "done" }],
            status: "completed",
          },
          {
            type: "function_call",
            id: "fc_0052fa548fed1375016a0e8d5da1cc819bbbf26f40ef48320c",
            call_id: "call_1",
            name: "Read",
            arguments: "{}",
          },
          {
            role: "user",
            content: [{ type: "input_text", text: "next" }],
          },
        ],
      };

      const finalMessage = {
        ...assistantMessage(),
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
      } satisfies AssistantMessage;
      const doneEvent: AssistantMessageEvent = {
        type: "done",
        reason: "stop",
        message: finalMessage,
      };
      async function* iterator() {
        sanitizedPayload = await options?.onPayload?.(payload, _model);
        yield doneEvent;
      }
      return Object.assign(iterator(), {
        result: async () => finalMessage,
      });
    };

    const adapter = new PiStreamAdapter({ stream });
    const turnInput = input();
    for await (const _event of adapter.stream({
      ...turnInput,
      agent: {
        ...turnInput.agent,
        model: "openai/gpt-5.5",
        model_settings: { provider_type: "openai" },
      },
    })) {
      // drain
    }

    expect(sanitizedPayload).toMatchObject({
      input: [
        { type: "reasoning", encrypted_content: "opaque" },
        { type: "message", role: "assistant", status: "completed" },
        { type: "function_call", call_id: "call_1", name: "Read" },
        { role: "user" },
      ],
    });
    expect(JSON.stringify(sanitizedPayload)).not.toContain("rs_0052");
    expect(JSON.stringify(sanitizedPayload)).not.toContain("msg_0052");
    expect(JSON.stringify(sanitizedPayload)).not.toContain("fc_0052");
  });

  test("drops empty text blocks before OpenRouter Anthropic requests", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "pi-stream-openrouter-empty-text-"),
    );
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "openrouter",
        providerName: "lc-openrouter",
        apiKey: "secret-key",
      });

      let capturedContext: Context | undefined;
      const stream: PiStreamFunction = (
        _model: Model<string>,
        context: Context,
        _options?: SimpleStreamOptions & Record<string, unknown>,
      ) => {
        capturedContext = context;
        const finalMessage = assistantMessage();
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: finalMessage }],
          finalMessage,
        );
      };

      const adapter = new PiStreamAdapter({
        stream,
        localProviderAuthStorageDir: storageDir,
      });
      const baseInput = input();
      for await (const _event of adapter.stream({
        ...baseInput,
        agent: {
          ...baseInput.agent,
          model: "openrouter/anthropic/claude-sonnet-4",
          model_settings: { provider_type: "openrouter" },
        },
        uiMessages: [
          {
            id: "ui-msg-empty-user",
            role: "user",
            content: [{ type: "text", text: "" }],
            timestamp: Date.now(),
          },
          {
            id: "ui-msg-user",
            role: "user",
            content: [
              { type: "text", text: "   " },
              { type: "text", text: "hello" },
            ],
            timestamp: Date.now(),
          },
          {
            id: "ui-msg-assistant",
            role: "assistant",
            content: [
              { type: "text", text: "" },
              {
                type: "toolCall",
                id: "call-readme",
                name: "Read",
                arguments: { path: "README.md" },
              },
            ],
            api: "openai-completions",
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4",
            usage: emptyLocalUsage(),
            stopReason: "toolUse",
            timestamp: Date.now(),
          },
          {
            id: "ui-msg-tool",
            role: "toolResult",
            toolCallId: "call-readme",
            toolName: "Read",
            content: [{ type: "text", text: "" }],
            isError: false,
            timestamp: Date.now(),
          },
        ],
      })) {
        // drain
      }

      const messages = capturedContext?.messages ?? [];
      expect(emptyTextBlocks(messages)).toEqual([]);
      expect(messages).toHaveLength(3);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "hello" }],
      });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-readme",
            name: "Read",
            arguments: { path: "README.md" },
          },
        ],
      });
      expect(messages[2]).toMatchObject({
        role: "toolResult",
        content: [{ type: "text", text: "No result provided" }],
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("forwards Bedrock provider options and restores AWS env overrides", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-stream-bedrock-"));
    const originalAccessKeyId = process.env.AWS_ACCESS_KEY_ID;
    const originalSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
    const originalRegion = process.env.AWS_REGION;
    try {
      process.env.AWS_ACCESS_KEY_ID = "old-access";
      delete process.env.AWS_SECRET_ACCESS_KEY;
      delete process.env.AWS_REGION;
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "bedrock",
        providerName: "lc-bedrock",
        apiKey: "secret-key",
        accessKey: "access-key",
        region: "us-west-2",
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedEnv: Record<string, string | undefined> | undefined;
      const stream: PiStreamFunction = (
        _model: Model<string>,
        _context: Context,
        options?: SimpleStreamOptions & Record<string, unknown>,
      ) => {
        capturedOptions = options;
        capturedEnv = {
          AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
          AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
          AWS_REGION: process.env.AWS_REGION,
        };
        const finalMessage = assistantMessage();
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: finalMessage }],
          finalMessage,
        );
      };

      const adapter = new PiStreamAdapter({
        stream,
        localProviderAuthStorageDir: storageDir,
      });
      for await (const _event of adapter.stream(input())) {
        // drain
      }

      expect(capturedOptions).toMatchObject({ region: "us-west-2" });
      expect(capturedEnv).toMatchObject({
        AWS_ACCESS_KEY_ID: "access-key",
        AWS_SECRET_ACCESS_KEY: "secret-key",
        AWS_REGION: "us-west-2",
      });
      expect(process.env.AWS_ACCESS_KEY_ID).toBe("old-access");
      expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(process.env.AWS_REGION).toBeUndefined();
    } finally {
      if (originalAccessKeyId === undefined) {
        delete process.env.AWS_ACCESS_KEY_ID;
      } else {
        process.env.AWS_ACCESS_KEY_ID = originalAccessKeyId;
      }
      if (originalSecretAccessKey === undefined) {
        delete process.env.AWS_SECRET_ACCESS_KEY;
      } else {
        process.env.AWS_SECRET_ACCESS_KEY = originalSecretAccessKey;
      }
      if (originalRegion === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = originalRegion;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves max reasoning effort through pi-ai Fable payload", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-stream-fable-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      const stream: PiStreamFunction = (
        _model: Model<string>,
        _context: Context,
        options?: SimpleStreamOptions & Record<string, unknown>,
      ) => {
        capturedOptions = options;
        const finalMessage = {
          ...assistantMessage(),
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-fable-5",
        } satisfies AssistantMessage;
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: finalMessage }],
          finalMessage,
        );
      };

      const adapter = new PiStreamAdapter({
        stream,
        localProviderAuthStorageDir: storageDir,
      });
      const baseInput = input();
      for await (const _event of adapter.stream({
        ...baseInput,
        agent: {
          ...baseInput.agent,
          model: "anthropic/claude-fable-5",
          model_settings: {
            provider_type: "anthropic",
            effort: "max",
          },
        },
      })) {
        // drain
      }

      expect(capturedOptions).toMatchObject({ reasoning: "xhigh" });
      const rewrittenPayload = await capturedOptions?.onPayload?.(
        {
          model: "claude-fable-5",
          output_config: { effort: "xhigh" },
        },
        { id: "claude-fable-5" } as Model<string>,
      );
      expect(rewrittenPayload).toMatchObject({
        output_config: { effort: "max" },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("strips trailing assistant messages from context before calling provider", async () => {
    let capturedContext: Context | undefined;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      context: Context,
    ) => {
      capturedContext = context;
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({ stream });

    // Simulate the retry scenario: conversation ends with a partial assistant
    // message (e.g. after a timeout), and the retry sends no new user input.
    const inputWithTrailingAssistant: ProviderTurnInput = {
      ...input(),
      uiMessages: [
        {
          id: "ui-msg-1",
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.now(),
        },
        {
          id: "ui-msg-2",
          role: "assistant",
          content: [{ type: "text", text: "partial response" }],
          api: "anthropic" as never,
          provider: "anthropic" as never,
          model: "claude-sonnet-4-6",
          usage: emptyLocalUsage(),
          stopReason: "stop",
          timestamp: Date.now(),
        } as never,
      ],
    };

    for await (const _event of adapter.stream(inputWithTrailingAssistant)) {
      // drain
    }

    expect(capturedContext).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: capturedContext is asserted defined on the line above
    const messages = capturedContext!.messages;
    // The trailing assistant message should be stripped
    expect(messages.at(-1)?.role).toBe("user");
    expect(messages).toHaveLength(1);
  });

  test("drops orphan tool results from provider context", async () => {
    let capturedContext: Context | undefined;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      context: Context,
    ) => {
      capturedContext = context;
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({ stream });
    const turnInput: ProviderTurnInput = {
      ...input(),
      uiMessages: [
        {
          id: "ui-msg-1",
          role: "user",
          content: "hello",
          timestamp: Date.now(),
        },
        {
          id: "ui-msg-2",
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-valid",
              name: "Read",
              arguments: { path: "README.md" },
            },
          ],
          api: "openai-responses" as never,
          provider: "openai" as never,
          model: "gpt-5.5",
          usage: emptyLocalUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        },
        {
          id: "ui-msg-3",
          role: "toolResult",
          toolCallId: "call-valid",
          toolName: "Read",
          content: [{ type: "text", text: "README contents" }],
          isError: false,
          timestamp: Date.now(),
        },
        {
          id: "ui-msg-4",
          role: "toolResult",
          toolCallId: "call-missing",
          toolName: "Read",
          content: [{ type: "text", text: "orphan contents" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    };

    for await (const _event of adapter.stream(turnInput)) {
      // drain
    }

    expect(capturedContext).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: capturedContext is asserted defined on the line above
    const messages = capturedContext!.messages;
    expect(JSON.stringify(messages)).toContain("README contents");
    expect(JSON.stringify(messages)).not.toContain("orphan contents");
    expect(
      messages.filter((message) => message.role === "toolResult"),
    ).toHaveLength(1);
  });

  test("retries retryable Codex transport errors before model output", async () => {
    let calls = 0;
    const stream: PiStreamFunction = () => {
      calls += 1;
      if (calls === 1) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }

      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({ stream });
    const events: ProviderStreamEvent[] = [];
    for await (const event of adapter.stream(input())) {
      events.push(event);
    }

    expect(calls).toBe(2);
    const retryEvent = events.find((event) => {
      if (event.type !== "letta-chunk") return false;
      const chunk = event.chunk as {
        message_type?: string;
        event_type?: string;
      };
      return (
        chunk.message_type === "event_message" && chunk.event_type === "retry"
      );
    });
    expect(retryEvent).toBeDefined();
    if (!retryEvent || retryEvent.type !== "letta-chunk") {
      throw new Error("Expected retry event");
    }
    expect(
      (retryEvent.chunk as { event_data?: { message?: string } }).event_data
        ?.message,
    ).toContain("WebSocket closed 1006 Connection ended");
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("accepts empty successful local provider responses like pi agent loop", async () => {
    let calls = 0;
    const stream: PiStreamFunction = () => {
      calls += 1;
      const finalMessage = { ...assistantMessage(), content: [] };
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    const adapter = new PiStreamAdapter({ stream });
    const events: ProviderStreamEvent[] = [];
    for await (const event of adapter.stream(input())) {
      events.push(event);
    }

    expect(calls).toBe(1);
    expect(
      events.some((event) => {
        if (event.type !== "letta-chunk") return false;
        const chunk = event.chunk as {
          message_type?: string;
          event_type?: string;
        };
        return (
          chunk.message_type === "event_message" && chunk.event_type === "retry"
        );
      }),
    ).toBe(false);
    const localMessages = events.filter(
      (event) => event.type === "local-message",
    );
    expect(localMessages).toHaveLength(1);
    expect(JSON.stringify(localMessages[0])).toContain('"content":[]');
  });

  test("accepts reasoning-only successful local provider responses like pi agent loop", async () => {
    const finalMessage = {
      ...assistantMessage(),
      content: [{ type: "thinking", thinking: "done thinking" }],
    } satisfies AssistantMessage;
    const stream: PiStreamFunction = () =>
      streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );

    const adapter = new PiStreamAdapter({ stream });
    const events: ProviderStreamEvent[] = [];
    for await (const event of adapter.stream(input())) {
      events.push(event);
    }

    const localMessages = events.filter(
      (event) => event.type === "local-message",
    );
    expect(localMessages).toHaveLength(1);
    expect(JSON.stringify(localMessages[0])).toContain("done thinking");
  });

  test("maps local ChatGPT priority service tier to pi-ai serviceTier", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "pi-stream-chatgpt-fast-"));
    try {
      setLocalOAuthProvider({
        storageDir,
        providerName: LOCAL_CHATGPT_PROVIDER_NAME,
        providerType: "chatgpt_oauth",
        auth: {
          type: "oauth",
          access: "access-token",
          refresh: "refresh-token",
          idToken: "id-token",
          expires: Date.now() + 60_000,
          accountId: "account-id",
        },
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      const stream: PiStreamFunction = (
        _model: Model<string>,
        _context: Context,
        options?: SimpleStreamOptions & Record<string, unknown>,
      ) => {
        capturedOptions = options;
        const finalMessage = {
          ...assistantMessage(),
          api: "openai-codex-responses",
          provider: "openai-codex",
          model: "gpt-5.5",
        } satisfies AssistantMessage;
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: finalMessage }],
          finalMessage,
        );
      };

      const adapter = new PiStreamAdapter({
        stream,
        localProviderAuthStorageDir: storageDir,
      });
      const baseInput = input();
      for await (const _event of adapter.stream({
        ...baseInput,
        agent: {
          ...baseInput.agent,
          model: "openai-codex/gpt-5.5",
          model_settings: {
            provider_type: "chatgpt_oauth",
            service_tier: "priority",
          },
        },
      })) {
        // drain
      }

      expect(capturedOptions).toMatchObject({ serviceTier: "priority" });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("emits llm_start and llm_end around a provider request", async () => {
    const finalMessage: AssistantMessage = {
      ...assistantMessage(),
      usage: { ...emptyLocalUsage(), input: 11, output: 7, totalTokens: 18 },
    };
    const stream: PiStreamFunction = () =>
      streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );

    const starts: LlmStartInfo[] = [];
    const ends: LlmEndInfo[] = [];
    const adapter = new PiStreamAdapter({
      stream,
      onLlmStart: (info) => {
        starts.push(info);
      },
      onLlmEnd: (info) => {
        ends.push(info);
      },
    });
    await collectEvents(adapter.stream(input()));

    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      agentId: "agent-local-1",
      conversationId: "local-conv-1",
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      messageCount: 1,
    });
    expect(starts[0]?.contextWindow).toBeGreaterThan(0);

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      agentId: "agent-local-1",
      conversationId: "local-conv-1",
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      stopReason: "stop",
      usage: { promptTokens: 11, completionTokens: 7, totalTokens: 18 },
    });
    expect(ends[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("emits llm_end for failed and successful provider requests across retries", async () => {
    let calls = 0;
    const stream: PiStreamFunction = () => {
      calls += 1;
      if (calls === 1) {
        const error = assistantErrorMessage(
          "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
        );
        return streamFromEvents(
          [{ type: "error", reason: "error", error }],
          error,
        );
      }
      const finalMessage = assistantMessage();
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );
    };

    let startCount = 0;
    const ends: LlmEndInfo[] = [];
    const adapter = new PiStreamAdapter({
      stream,
      onLlmStart: () => {
        startCount += 1;
      },
      onLlmEnd: (info) => {
        ends.push(info);
      },
    });
    await collectEvents(adapter.stream(input()));

    expect(calls).toBe(2);
    expect(startCount).toBe(2);
    expect(ends).toHaveLength(2);
    expect(ends[0]).toMatchObject({
      stopReason: "llm_api_error",
      usage: null,
      error: {
        errorType: "llm_error",
        retryable: true,
      },
    });
    expect(ends[0]?.error?.message).toContain("WebSocket closed");
    expect(ends[1]).toMatchObject({
      stopReason: "stop",
    });
    expect(ends[1]?.error).toBeUndefined();
    expect(ends[1]?.usage).not.toBeNull();
  });

  test("emits one llm_end with error details for final error messages", async () => {
    const finalMessage = assistantErrorMessage("usage limit reached");
    const stream: PiStreamFunction = () =>
      streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
        finalMessage,
      );

    const ends: LlmEndInfo[] = [];
    const adapter = new PiStreamAdapter({
      stream,
      onLlmEnd: (info) => {
        ends.push(info);
      },
    });

    await expect(collectEvents(adapter.stream(input()))).rejects.toThrow(
      "usage limit reached",
    );

    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({
      stopReason: "error",
      usage: {
        promptTokens: finalMessage.usage.input,
        completionTokens: finalMessage.usage.output,
        totalTokens: finalMessage.usage.totalTokens,
      },
      error: {
        message: "usage limit reached",
        retryable: false,
      },
    });
  });
});
