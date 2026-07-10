import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Model,
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

function completedStream(model: Model<string>): ReturnType<PiStreamFunction> {
  const finalMessage: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const done: AssistantMessageEvent = {
    type: "done",
    reason: "stop",
    message: finalMessage,
  };
  async function* iterator() {
    yield done;
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

function llamaInput(content: string): ProviderTurnInput {
  return {
    conversationId: "local-conv-budget",
    agentId: "agent-local-budget",
    agent: {
      id: "agent-local-budget",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model:
        "llama.cpp/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-IQ4_XS.gguf",
      model_settings: {
        provider_type: "llama_cpp",
        context_window_limit: 128000,
        max_tokens: 32000,
      },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-msg-budget",
        role: "user",
        content,
        timestamp: Date.now(),
      },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

describe("pi output budget", () => {
  test("compacts instead of silently clamping a 128k llama.cpp turn to one token", async () => {
    let providerCalls = 0;
    let overflowError: unknown;
    const stream: PiStreamFunction = (model) => {
      providerCalls += 1;
      return completedStream(model);
    };
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
          summary: "compacted near-limit context",
        };
      },
    });

    const nearLimitContent = "x".repeat((128000 - 4096) * 4);
    const events = await collectEvents(
      adapter.stream(llamaInput(nearLimitContent)),
    );

    expect(providerCalls).toBe(1);
    expect(String(overflowError)).toContain("leaves only 1 output token");
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
});
