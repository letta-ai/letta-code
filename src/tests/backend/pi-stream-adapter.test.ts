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
} from "../../backend/dev/PiStreamAdapter";
import type { ProviderTurnInput } from "../../backend/dev/ProviderTurnExecutor";
import { emptyLocalUsage } from "../../backend/local/LocalMessage";
import { createOrUpdateLocalProvider } from "../../backend/local/LocalProviderAuthStore";

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
});
