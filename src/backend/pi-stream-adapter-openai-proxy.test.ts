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
import type { ProviderTurnInput } from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";
import {
  createOrUpdateLocalProvider,
  LOCAL_CHATGPT_PROVIDER_NAME,
} from "@/backend/local/local-provider-auth-store";

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.5",
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
      model: "openai-codex/gpt-5.5",
      model_settings: {
        provider_type: "chatgpt_oauth",
        max_tokens: 16_384,
      },
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

describe("PiStreamAdapter ChatGPT proxy routing", () => {
  test("uses OpenAI Responses requests", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "pi-stream-chatgpt-proxy-"),
    );

    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "chatgpt_oauth",
        providerName: LOCAL_CHATGPT_PROVIDER_NAME,
        apiKey: JSON.stringify({
          access_token: "access-token",
          id_token: "id-token",
          account_id: "account-id",
          expires_at: Date.now() + 60_000,
        }),
        baseURL: "https://proxy.example.test",
      });

      let capturedOptions:
        | (SimpleStreamOptions & Record<string, unknown>)
        | undefined;
      let capturedModel: Model<string> | undefined;
      const stream: PiStreamFunction = (
        model: Model<string>,
        _context: Context,
        options?: SimpleStreamOptions & Record<string, unknown>,
      ) => {
        capturedModel = model;
        capturedOptions = options;
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

      expect(capturedOptions).toMatchObject({ apiKey: "access-token" });
      expect(capturedOptions).not.toHaveProperty("maxTokens");
      expect(capturedModel).toMatchObject({
        api: "openai-responses",
        baseUrl: "https://proxy.example.test",
        headers: { "chatgpt-account-id": "account-id" },
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
