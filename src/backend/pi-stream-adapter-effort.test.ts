import { expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
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

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5-2",
    providerThinkingLevel: "high",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: 2,
  };
}

function input(effort?: string): ProviderTurnInput {
  return {
    conversationId: "local-conv-1",
    agentId: "agent-local-1",
    agent: {
      id: "agent-local-1",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "anthropic/claude-fable-5-2",
      model_settings: {
        provider_type: "anthropic",
        ...(effort ? { effort } : {}),
      },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      { id: "user-1", role: "user", content: "First", timestamp: 1 },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

function streamFromMessage(
  message: AssistantMessage,
  inspect: (context: Context, options?: SimpleStreamOptions) => void,
): PiStreamFunction {
  return (_model, context, options) => {
    inspect(context, options);
    async function* events(): AsyncIterable<AssistantMessageEvent> {
      yield { type: "done", reason: "stop", message };
    }
    return Object.assign(events(), { result: async () => message });
  };
}

async function collect(events: AsyncIterable<ProviderStreamEvent>) {
  const output: ProviderStreamEvent[] = [];
  for await (const event of events) output.push(event);
  return output;
}

test("preserves provider effort on completed messages and replay context", async () => {
  const completed = assistantMessage();
  let replay: Context | undefined;
  const adapter = new PiStreamAdapter({
    stream: streamFromMessage(completed, (context) => {
      replay = context;
    }),
  });
  const events = await collect(
    adapter.stream({
      ...input(),
      uiMessages: [
        { id: "user-1", role: "user", content: "First", timestamp: 1 },
        { id: "assistant-1", ...completed },
        { id: "user-2", role: "user", content: "Continue", timestamp: 3 },
      ],
    }),
  );
  expect(
    replay?.messages.find((message) => message.role === "assistant"),
  ).toMatchObject({ providerThinkingLevel: "high" });
  expect(events.find((event) => event.type === "local-message")).toMatchObject({
    message: { providerThinkingLevel: "high" },
  });
});

test("passes managed Anthropic max effort to pi-ai without overriding its payload", async () => {
  let options: SimpleStreamOptions | undefined;
  const adapter = new PiStreamAdapter({
    stream: streamFromMessage(assistantMessage(), (_context, next) => {
      options = next;
    }),
  });
  await collect(adapter.stream(input("max")));
  expect(options?.reasoning).toBe("max");
  expect(options?.onPayload).toBeUndefined();
});
