import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
} from "@earendil-works/pi-ai";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
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
  test("compacts before dispatch after a large MemFS commit (#4893)", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-memory-pressure-"));
    try {
      const contexts: Context[] = [];
      const order: string[] = [];
      const backend = new LocalBackend({
        storageDir,
        stream: (_model, context) => {
          order.push("provider");
          contexts.push(context);
          const message = assistantMessage("provider response");
          if (contexts.length === 1) {
            message.usage = {
              ...emptyLocalUsage(),
              input: 7_100,
              output: 100,
              totalTokens: 7_200,
            };
          }
          return streamFromMessage(message);
        },
        complete: async () => {
          order.push("compaction");
          return assistantMessage("compacted memory conversation");
        },
      });
      const agent = await backend.createAgent({
        name: "Memory Pressure",
        system: "base {CORE_MEMORY}",
        model: "openai/gpt-5.5",
        context_window_limit: 10_000,
        model_settings: {
          provider_type: "openai",
        },
        compaction_settings: { mode: "all" },
      });
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      });
      await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "first" }],
        }),
      );

      const memoryDir = join(storageDir, "memfs", agent.id, "memory");
      const memory = `Updated persona: ${"m".repeat(12_000)}`;
      await writeFile(
        join(memoryDir, "persona.md"),
        `---\nname: "Persona"\ndescription: "Who the agent is"\n---\n${memory}\n`,
        "utf8",
      );
      execFileSync("git", ["add", "persona.md"], { cwd: memoryDir });
      execFileSync("git", ["commit", "-m", "test memory update"], {
        cwd: memoryDir,
      });

      const chunks = await collect(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "next" }],
        }),
      );

      expect(order).toEqual(["provider", "compaction", "provider"]);
      expect(contexts).toHaveLength(2);
      expect(JSON.stringify(contexts[1]?.messages)).toContain(
        "compacted memory conversation",
      );
      expect(JSON.stringify(contexts[1]?.messages)).toContain(memory);
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "event_message",
          event_type: "compaction",
          event_data: { trigger: "context_window_limit" },
        }),
      );
      expect(chunks).toContainEqual(
        expect.objectContaining({
          message_type: "stop_reason",
          stop_reason: "end_turn",
        }),
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

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
});
