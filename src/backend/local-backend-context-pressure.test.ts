import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import type {
  LettaStreamingResponse,
  SummaryMessage,
} from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function streamFromMessage(
  message: AssistantMessage,
): ReturnType<PiStreamFunction> {
  const event: AssistantMessageEvent = {
    type: "done",
    reason: "stop",
    message,
  };
  async function* iterator() {
    yield event;
  }
  return Object.assign(iterator(), {
    result: async () => message,
  });
}

async function collect(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("LocalBackend context pressure", () => {
  test("persists preflight compaction before dispatching the provider request", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-context-pressure-"),
    );
    try {
      const providerContexts: Context[] = [];
      const stream: PiStreamFunction = (_model, context) => {
        providerContexts.push(context);
        return streamFromMessage(assistantMessage("provider response"));
      };
      const complete = async (): Promise<AssistantMessage> =>
        assistantMessage("compacted before dispatch");
      const backend = new LocalBackend({
        storageDir,
        stream,
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Context Pressure",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
        } as ConversationMessageCreateBody),
      );

      expect(providerContexts).toHaveLength(1);
      expect(providerContexts[0]?.messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("compacted before dispatch"),
            }),
          ],
        }),
      ]);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "event_message",
          event_type: "compaction",
          event_data: { trigger: "context_window_limit" },
        }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "summary_message",
          summary: "compacted before dispatch",
        }),
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("honors a persisted context window nested in conversation model settings", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-conversation-context-pressure-"),
    );
    try {
      const initialBackend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
      });
      const agent = await initialBackend.createAgent({
        name: "Context Pressure",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 100_000,
        },
      } as never);
      const conversation = await initialBackend.createConversation({
        agent_id: agent.id,
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
      } as never);

      const providerContexts: Context[] = [];
      const stream: PiStreamFunction = (_model, context) => {
        providerContexts.push(context);
        return streamFromMessage(assistantMessage("provider response"));
      };
      const backend = new LocalBackend({
        storageDir,
        stream,
        complete: async () => assistantMessage("compacted after reload"),
        memfsEnabled: false,
      });
      const reloadedConversation = (await backend.retrieveConversation(
        conversation.id,
      )) as unknown as {
        model_settings?: { context_window_limit?: number } | null;
      };
      expect(reloadedConversation.model_settings?.context_window_limit).toBe(
        1_000,
      );

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
        } as ConversationMessageCreateBody),
      );

      expect(providerContexts).toHaveLength(1);
      expect(providerContexts[0]?.messages).toEqual([
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "text",
              text: expect.stringContaining("compacted after reload"),
            }),
          ],
        }),
      ]);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "event_message",
          event_type: "compaction",
          event_data: { trigger: "context_window_limit" },
        }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "summary_message",
          summary: "compacted after reload",
        }),
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("self-compaction summarizes with the turn's system prompt and tools", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-self-compaction-"));
    try {
      const providerContexts: Context[] = [];
      const compactionContexts: Context[] = [];
      const backend = new LocalBackend({
        storageDir,
        stream: (_model, context) => {
          providerContexts.push(context);
          return streamFromMessage(assistantMessage("provider response"));
        },
        complete: async (_model, context) => {
          compactionContexts.push(context);
          return assistantMessage("self summary");
        },
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Self Compaction",
        system: "You are the self-compaction agent.",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
        compaction_settings: {
          mode: "self_compact_all",
          prompt: "Summarize the conversation now.",
        },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
          client_tools: [
            {
              name: "Bash",
              description: "Run a command",
              parameters: { type: "object", properties: {} },
            },
          ],
        } as ConversationMessageCreateBody),
      );

      expect(compactionContexts).toHaveLength(1);
      const [compaction] = compactionContexts;
      expect(compaction?.systemPrompt).toContain(
        "You are the self-compaction agent.",
      );
      expect(compaction?.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
      // The user's message has not reached the model yet, so the prompt
      // joins it: nothing is written in the model's name, and no two user
      // messages follow each other.
      expect(compaction?.messages.map((message) => message.role)).toEqual([
        "user",
      ]);
      const content = compaction?.messages[0]?.content;
      expect(JSON.stringify(content)).toContain("x".repeat(100));
      expect(Array.isArray(content) ? content.at(-1) : content).toEqual({
        type: "text",
        text: "Summarize the conversation now.",
      });
      expect(providerContexts).toHaveLength(1);
      expect(JSON.stringify(providerContexts[0]?.messages)).toContain(
        "self summary",
      );

      // Manual compaction has no turn: the compiled prompt, and no tools.
      await backend.compactConversationMessages(conversation.id, {
        agent_id: agent.id,
      } as never);
      expect(compactionContexts).toHaveLength(2);
      expect(compactionContexts[1]?.systemPrompt).toContain(
        "You are the self-compaction agent.",
      );
      expect(compactionContexts[1]?.tools).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("reports a self-compaction overflow fallback on the emitted and stored summary", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-self-compaction-source-"),
    );
    try {
      const compactionContexts: Context[] = [];
      const backend = new LocalBackend({
        storageDir,
        stream: () => streamFromMessage(assistantMessage("provider response")),
        complete: async (_model, context) => {
          compactionContexts.push(context);
          if (compactionContexts.length === 1) {
            throw new Error(
              "This model's maximum context length is 1000 tokens. (context_length_exceeded)",
            );
          }
          return assistantMessage("transcript summary");
        },
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Self Compaction",
        model: "openai/gpt-5.5",
        model_settings: {
          provider_type: "openai",
          context_window_limit: 1_000,
        },
        compaction_settings: { mode: "self_compact_all" },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "x".repeat(4_000) }],
        } as ConversationMessageCreateBody),
      );

      expect(compactionContexts).toHaveLength(2);
      const summaryMessage = expect.objectContaining({
        message_type: "summary_message",
        summary: "transcript summary",
        compaction_stats: expect.objectContaining({
          trigger: "context_window_limit",
          summary_source: "transcript_after_overflow",
        }),
      });
      expect(chunks).toContainEqual(summaryMessage);

      // The stored transcript keeps the source, including after a reload.
      const reloaded = new LocalBackend({ storageDir, memfsEnabled: false });
      for (const reader of [backend, reloaded]) {
        const page = await reader.listConversationMessages(conversation.id, {
          agent_id: agent.id,
        } as never);
        const stored = page
          .getPaginatedItems()
          .filter(
            (message): message is SummaryMessage =>
              message.message_type === "summary_message",
          );
        expect(stored).toContainEqual(summaryMessage);
        expect(
          stored.map((message) => message.compaction_stats?.summary_source),
        ).not.toContain(undefined);
      }
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
