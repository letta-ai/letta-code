import { expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import {
  LocalProviderRetryExhaustedError,
  normalizeLocalProviderError,
} from "@/backend/dev/local-provider-errors";
import {
  PiStreamAdapter,
  type PiStreamFunction,
} from "@/backend/dev/pi-stream-adapter";
import type {
  LlmEndInfo,
  ProviderStreamEvent,
  ProviderTurnInput,
} from "@/backend/dev/provider-turn-executor";
import { emptyLocalUsage } from "@/backend/local/local-message";

function assistantErrorMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: emptyLocalUsage(),
    stopReason: "error",
    errorMessage: "WebSocket closed 1006 Connection ended\nretry-after-ms: 0",
    timestamp: Date.now(),
  };
}

function streamFromError(
  error: AssistantMessage,
  options: { emitModelOutput?: boolean } = {},
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    if (options.emitModelOutput) {
      yield {
        type: "text_delta",
        contentIndex: 0,
        delta: "partial",
        partial: error,
      } as AssistantMessageEvent;
    }
    yield { type: "error", reason: "error", error } as AssistantMessageEvent;
  }
  return Object.assign(iterator(), { result: async () => error });
}

function input(): ProviderTurnInput {
  return {
    conversationId: "local-conv-retry-budget",
    agentId: "agent-local-retry-budget",
    agent: {
      id: "agent-local-retry-budget",
      name: "Local",
      description: null,
      system: "system",
      tags: [],
      model: "openai-codex/gpt-5.6-sol",
      model_settings: { provider_type: "chatgpt_oauth" },
    },
    body: { messages: [] } as never,
    history: [],
    uiMessages: [
      {
        id: "ui-msg-retry-budget",
        role: "user",
        content: "hello",
        timestamp: Date.now(),
      },
    ],
    clientTools: [],
    clientSkills: [],
  };
}

test("exhausted local provider retries suppress outer turn retries", async () => {
  let calls = 0;
  const stream: PiStreamFunction = () => {
    calls += 1;
    return streamFromError(assistantErrorMessage());
  };
  const llmEnds: LlmEndInfo[] = [];
  const adapter = new PiStreamAdapter({
    stream,
    onLlmEnd: (info) => {
      llmEnds.push(info);
    },
  });
  const events: ProviderStreamEvent[] = [];
  let thrown: unknown;

  try {
    for await (const event of adapter.stream(input())) events.push(event);
  } catch (error) {
    thrown = error;
  }

  expect(calls).toBe(4);
  expect(thrown).toBeInstanceOf(LocalProviderRetryExhaustedError);
  expect(normalizeLocalProviderError(thrown)).toMatchObject({
    error_type: "llm_error",
    retryable: false,
    stop_reason: "llm_api_error",
  });
  expect(llmEnds.at(-1)?.error).toMatchObject({
    errorType: "llm_error",
    retryable: false,
  });
  const retryEvents = events.filter(
    (event) =>
      event.type === "letta-chunk" &&
      (event.chunk as { event_type?: string }).event_type === "retry",
  );
  expect(retryEvents).toHaveLength(3);
  expect(retryEvents[0]).toMatchObject({
    chunk: {
      event_data: {
        attempt: 1,
        max_attempts: 3,
        message: "OpenAI Codex WebSocket closed (1006)",
      },
    },
  });
});

test("keeps final failures retryable when the provider emitted model output", async () => {
  let calls = 0;
  const stream: PiStreamFunction = () => {
    calls += 1;
    return streamFromError(assistantErrorMessage(), {
      emitModelOutput: calls === 4,
    });
  };
  const llmEnds: LlmEndInfo[] = [];
  const adapter = new PiStreamAdapter({
    stream,
    onLlmEnd: (info) => {
      llmEnds.push(info);
    },
  });
  let thrown: unknown;

  try {
    for await (const _event of adapter.stream(input())) {
      // Drain the stream so the final provider error is observed.
    }
  } catch (error) {
    thrown = error;
  }

  expect(calls).toBe(4);
  expect(thrown).not.toBeInstanceOf(LocalProviderRetryExhaustedError);
  expect(normalizeLocalProviderError(thrown).retryable).toBe(true);
  expect(llmEnds.at(-1)?.error?.retryable).toBe(true);
});
