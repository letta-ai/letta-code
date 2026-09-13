import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
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

function completedMessage(
  api: AssistantMessage["api"],
  provider: string,
  model: string,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    api,
    provider,
    model,
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamFromMessage(
  message: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator(): AsyncGenerator<AssistantMessageEvent> {
    yield { type: "done", reason: "stop", message };
  }
  return Object.assign(iterator(), { result: async () => message });
}

async function drain(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<void> {
  for await (const _event of events) {
    // Drain the provider stream so the captured request represents a full call.
  }
}

function input(model: string, conversationId: string): ProviderTurnInput {
  return {
    conversationId,
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model,
      model_settings: {},
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-msg-1",
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

describe("PiStreamAdapter OpenCode Go session routing", () => {
  test.each([
    ["opencode-go/glm-5.2", "openai-completions"],
    ["opencode-go/gpt-5.6-luna", "openai-responses"],
    ["opencode-go/minimax-m3", "anthropic-messages"],
  ] as const)(
    "sends a stable conversation header for %s",
    async (model, api) => {
      const previousKey = process.env.OPENCODE_API_KEY;
      process.env.OPENCODE_API_KEY = "test-opencode-key";
      try {
        const capturedHeaders: Array<SimpleStreamOptions["headers"]> = [];
        const stream: PiStreamFunction = (
          resolvedModel,
          _context,
          options?: SimpleStreamOptions & Record<string, unknown>,
        ) => {
          capturedHeaders.push(options?.headers);
          return streamFromMessage(
            completedMessage(api, resolvedModel.provider, resolvedModel.id),
          );
        };
        const adapter = new PiStreamAdapter({ stream });

        await drain(adapter.stream(input(model, "conv-opencode-1")));
        await drain(adapter.stream(input(model, "conv-opencode-1")));
        await drain(adapter.stream(input(model, "conv-opencode-2")));

        expect(capturedHeaders).toEqual([
          { "x-opencode-session": "conv-opencode-1" },
          { "x-opencode-session": "conv-opencode-1" },
          { "x-opencode-session": "conv-opencode-2" },
        ]);
      } finally {
        if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
        else process.env.OPENCODE_API_KEY = previousKey;
      }
    },
  );

  test("does not send the OpenCode header to another provider", async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-openai-key";
    try {
      let capturedHeaders: SimpleStreamOptions["headers"];
      const stream: PiStreamFunction = (model, _context, options) => {
        capturedHeaders = options?.headers;
        return streamFromMessage(
          completedMessage(model.api, model.provider, model.id),
        );
      };
      const adapter = new PiStreamAdapter({ stream });

      await drain(adapter.stream(input("openai/gpt-5.5", "conv-openai-1")));

      expect(capturedHeaders?.["x-opencode-session"]).toBeUndefined();
    } finally {
      if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousKey;
    }
  });
});
