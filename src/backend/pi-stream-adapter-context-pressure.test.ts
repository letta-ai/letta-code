import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import {
  type LocalContextPressure,
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";

function usage(totalTokens: number, output = 100): Usage {
  return {
    input: Math.max(0, totalTokens - output),
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

type CompletedStopReason = "length" | "stop" | "toolUse";

function assistantMessage(
  input: {
    text?: string;
    stopReason?: CompletedStopReason;
    usage?: Usage;
  } = {},
): AssistantMessage & { stopReason: CompletedStopReason } {
  return {
    role: "assistant",
    content: [{ type: "text", text: input.text ?? "done" }],
    api: "bedrock-converse-stream",
    provider: "amazon-bedrock",
    model: "us.anthropic.claude-sonnet-4-6",
    usage: input.usage ?? emptyLocalUsage(),
    stopReason: input.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

function streamFromMessage(
  finalMessage: AssistantMessage & { stopReason: CompletedStopReason },
): ReturnType<PiStreamFunction> {
  const event: AssistantMessageEvent = {
    type: "done",
    reason: finalMessage.stopReason,
    message: finalMessage,
  };
  async function* iterator() {
    yield event;
  }
  return Object.assign(iterator(), {
    result: async () => finalMessage,
  });
}

function turnInput(
  input: { content?: string; contextWindow?: number; maxTokens?: number } = {},
): ProviderTurnInput {
  return {
    conversationId: "local-conv-context-pressure",
    agentId: "agent-local-context-pressure",
    agent: {
      id: "agent-local-context-pressure",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
      model_settings: {
        provider_type: "bedrock",
        context_window_limit: input.contextWindow ?? 100_000,
        ...(input.maxTokens !== undefined
          ? { max_tokens: input.maxTokens }
          : {}),
      },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-msg-context-pressure",
        role: "user",
        content: input.content ?? "hello",
        timestamp: Date.now(),
      },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

async function collectEvents(
  stream: AsyncIterable<ProviderStreamEvent>,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function compactionEvent(events: ProviderStreamEvent[]) {
  return events.find(
    (event) =>
      event.type === "letta-chunk" &&
      (event.chunk as { event_type?: string }).event_type === "compaction",
  );
}

describe("PiStreamAdapter context pressure", () => {
  test("compacts a 96k request before dispatching it into a 100k window", async () => {
    let providerCalls = 0;
    let providerContext: Context | undefined;
    const pressures: LocalContextPressure[] = [];
    const stream: PiStreamFunction = (_model, context) => {
      providerCalls += 1;
      providerContext = context;
      return streamFromMessage(assistantMessage());
    };
    const adapter = new PiStreamAdapter({
      stream,
      onContextPressure: async (_input, pressure) => {
        pressures.push(pressure);
        if (pressure.phase !== "preflight") return null;
        return {
          uiMessages: [
            {
              id: "ui-msg-compacted",
              role: "user",
              content: "compacted summary",
              timestamp: Date.now(),
            },
          ],
          summary: "compacted summary",
        };
      },
    });

    const events = await collectEvents(
      adapter.stream(turnInput({ content: "x".repeat(96_000 * 4) })),
    );

    expect(providerCalls).toBe(1);
    expect(providerContext?.messages).toEqual([
      expect.objectContaining({ role: "user", content: "compacted summary" }),
    ]);
    expect(pressures).toEqual([
      {
        contextTokens: expect.any(Number),
        contextWindow: 100_000,
        phase: "preflight",
        source: "estimate",
      },
    ]);
    expect(pressures[0]?.contextTokens).toBeGreaterThan(83_616);
    expect(compactionEvent(events)).toBeDefined();
  });

  test("compacts after exact usage enters the reserve", async () => {
    const pressures: LocalContextPressure[] = [];
    const stream: PiStreamFunction = () =>
      streamFromMessage(assistantMessage({ usage: usage(86_045) }));
    const adapter = new PiStreamAdapter({
      stream,
      onContextPressure: async (_input, pressure) => {
        pressures.push(pressure);
        return pressure.phase === "post_turn"
          ? {
              uiMessages: [],
              summary: "post-turn summary",
            }
          : null;
      },
    });

    const events = await collectEvents(adapter.stream(turnInput()));

    expect(pressures).toEqual([
      {
        contextTokens: 86_045,
        contextWindow: 100_000,
        phase: "post_turn",
        source: "usage",
      },
    ]);
    expect(compactionEvent(events)).toBeDefined();
    expect(events.some((event) => event.type === "local-message")).toBe(true);
  });

  test("includes the completed response in the post-turn fallback estimate", async () => {
    const pressures: LocalContextPressure[] = [];
    const stream: PiStreamFunction = () =>
      streamFromMessage(
        assistantMessage({ text: "y".repeat(600), usage: emptyLocalUsage() }),
      );
    const adapter = new PiStreamAdapter({
      stream,
      onContextPressure: async (_input, pressure) => {
        pressures.push(pressure);
        return null;
      },
    });

    await collectEvents(
      adapter.stream(
        turnInput({ content: "x".repeat(700 * 4), contextWindow: 1_000 }),
      ),
    );

    expect(pressures).toEqual([
      {
        contextTokens: expect.any(Number),
        contextWindow: 1_000,
        phase: "post_turn",
        source: "estimate",
      },
    ]);
    expect(pressures[0]?.contextTokens).toBeGreaterThan(800);
  });

  test("does not treat an explicit one-token output limit as context pressure", async () => {
    let capturedOptions:
      | (SimpleStreamOptions & Record<string, unknown>)
      | undefined;
    let pressureCalls = 0;
    const stream: PiStreamFunction = (
      _model: Model<string>,
      _context,
      options,
    ) => {
      capturedOptions = options;
      return streamFromMessage(
        assistantMessage({ stopReason: "length", usage: usage(2, 1) }),
      );
    };
    const adapter = new PiStreamAdapter({
      stream,
      onContextPressure: async () => {
        pressureCalls += 1;
        return null;
      },
    });

    const events = await collectEvents(
      adapter.stream(turnInput({ maxTokens: 1 })),
    );

    expect(capturedOptions?.maxTokens).toBe(1);
    expect(pressureCalls).toBe(0);
    expect(compactionEvent(events)).toBeUndefined();
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "provider-part",
        part: expect.objectContaining({ type: "done", reason: "length" }),
      }),
    );
  });
});
