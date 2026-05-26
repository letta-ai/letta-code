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
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";

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

  test("drops bare OpenAI reasoning signatures without encrypted_content", async () => {
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

    for await (const _event of adapter.stream({
      ...input(),
      uiMessages: [
        {
          id: "ui-msg-user",
          role: "user",
          content: "hello",
          timestamp: Date.now(),
        },
        {
          id: "ui-msg-assistant",
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: "",
              thinkingSignature:
                '{"id":"rs_123","type":"reasoning","summary":[]}',
            },
            {
              type: "toolCall",
              id: "call-recall",
              name: "Recall",
              arguments: { query: "test" },
            },
          ],
          api: "openai-responses",
          provider: "openai",
          model: "gpt-5.5",
          usage: emptyLocalUsage(),
          stopReason: "toolUse",
          timestamp: Date.now(),
        } as never,
        {
          id: "ui-msg-tool",
          role: "toolResult",
          toolCallId: "call-recall",
          toolName: "Recall",
          content: [{ type: "text", text: "result" }],
          isError: false,
          timestamp: Date.now(),
        },
      ],
    })) {
      // drain
    }

    expect(capturedContext).toBeDefined();

    const assistant = capturedContext?.messages.find(
      (message) => message.role === "assistant",
    );

    expect(assistant).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-recall",
          name: "Recall",
          arguments: { query: "test" },
        },
      ],
    });
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
});
