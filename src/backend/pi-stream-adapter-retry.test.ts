import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
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

const transportError =
  "WebSocket closed 1006 Connection ended\nretry-after-ms: 0";

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

function errorMessage(): AssistantMessage {
  return {
    ...assistantMessage(),
    content: [],
    stopReason: "error",
    errorMessage: transportError,
  };
}

function streamFromEvents(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), { result: async () => finalMessage });
}

function input(): ProviderTurnInput {
  return {
    conversationId: "local-conv-retry",
    agentId: "agent-local-retry",
    agent: {
      id: "agent-local-retry",
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

async function collect(events: AsyncIterable<ProviderStreamEvent>) {
  const collected: ProviderStreamEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

describe("PiStreamAdapter retry output boundary", () => {
  test("retries retryable transport errors before model output", async () => {
    let calls = 0;
    const stream: PiStreamFunction = () => {
      calls += 1;
      if (calls === 1) {
        const error = errorMessage();
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

    const events = await collect(
      new PiStreamAdapter({ stream }).stream(input()),
    );
    expect(calls).toBe(2);
    expect(
      events.some(
        (event) =>
          event.type === "letta-chunk" &&
          (event.chunk as { event_type?: string }).event_type === "retry",
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("does not retry after nonempty start-only model output", async () => {
    let calls = 0;
    const stream: PiStreamFunction = () => {
      calls += 1;
      const partial = {
        ...assistantMessage(),
        content: [
          { type: "thinking" as const, thinking: "[Reasoning redacted]" },
        ],
        stopReason: "error" as const,
      };
      const error = { ...errorMessage(), content: partial.content };
      return streamFromEvents(
        [
          { type: "thinking_start", contentIndex: 0, partial },
          { type: "error", reason: "error", error },
        ],
        error,
      );
    };

    const adapter = new PiStreamAdapter({ stream });
    const events: ProviderStreamEvent[] = [];
    let thrown: unknown;
    try {
      for await (const event of adapter.stream(input())) events.push(event);
    } catch (error) {
      thrown = error;
    }

    expect(String(thrown)).toContain("WebSocket closed 1006");
    expect(calls).toBe(1);
    expect(
      events.filter(
        (event) =>
          event.type === "provider-part" &&
          event.part.type === "thinking_start",
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event) => event.type === "local-message"),
    ).toHaveLength(1);
    expect(
      events.some(
        (event) =>
          event.type === "letta-chunk" &&
          (event.chunk as { event_type?: string }).event_type === "retry",
      ),
    ).toBe(false);
  });
});
