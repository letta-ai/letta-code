import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
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

async function runCase(
  modelSettings: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const storageDir = await mkdtemp(
    join(tmpdir(), "pi-stream-openrouter-max-tokens-"),
  );
  try {
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey: "secret-key",
    });
    let capturedOptions:
      | (SimpleStreamOptions & Record<string, unknown>)
      | undefined;
    let sanitizedPayload: unknown;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      _context: Context,
      options?: SimpleStreamOptions & Record<string, unknown>,
    ) => {
      capturedOptions = options;
      const finalMessage = assistantMessage();
      async function* iterator() {
        sanitizedPayload =
          (await options?.onPayload?.(payload, _model)) ?? payload;
        yield {
          type: "done" as const,
          reason: "stop" as const,
          message: finalMessage,
        };
      }
      return Object.assign(iterator(), { result: async () => finalMessage });
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
        model: "openrouter/~openai/gpt-astra-latest",
        model_settings: modelSettings,
      },
    })) {
      // drain
    }
    return { capturedOptions, sanitizedPayload };
  } finally {
    await rm(storageDir, { recursive: true, force: true });
  }
}

describe("PiStreamAdapter OpenRouter output budgets", () => {
  test("does not reserve the model ceiling by default", async () => {
    const result = await runCase(
      { provider_type: "openrouter" },
      { model: "~openai/gpt-astra-latest", max_tokens: 128000 },
    );
    expect(result.capturedOptions?.maxTokens).toBeUndefined();
    expect(result.sanitizedPayload).toEqual({
      model: "~openai/gpt-astra-latest",
    });
  });

  test("keeps an explicit output limit", async () => {
    const result = await runCase(
      { provider_type: "openrouter", max_tokens: 4096 },
      { model: "~openai/gpt-astra-latest", max_tokens: 4096 },
    );
    expect(result.capturedOptions?.maxTokens).toBe(4096);
    expect(result.sanitizedPayload).toEqual({
      model: "~openai/gpt-astra-latest",
      max_tokens: 4096,
    });
  });
});
