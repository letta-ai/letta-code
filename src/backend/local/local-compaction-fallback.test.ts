import { describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";
import type { LocalStore } from "@/backend/local/local-store";

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  const controller = new AbortController();
  return {
    controller,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

function assistantMessage(input: {
  content: AssistantMessage["content"];
  stopReason: AssistantMessage["stopReason"];
  responseId: string;
}): AssistantMessage {
  return {
    role: "assistant",
    content: input.content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    responseId: input.responseId,
    usage: emptyLocalUsage(),
    stopReason: input.stopReason,
    timestamp: Date.now(),
  };
}

function turnExecutor(): HeadlessTurnExecutor {
  return {
    async execute() {
      return lettaStreamFromChunks([
        {
          message_type: "assistant_message",
          content: [{ type: "text", text: "ok" }],
        } as LettaStreamingResponse,
        {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as LettaStreamingResponse,
      ]);
    },
  };
}

describe("local compaction fallback keeps custom prompt", () => {
  test("keeps custom compaction prompt when sliding-window planning falls back to full summarization", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-fallback-plan-"),
    );
    const customPrompt = "CUSTOM-SUMMARY-PROMPT: summarize as haiku";
    const systemPromptsSeen: Array<string | undefined> = [];
    const complete = async (
      _model: unknown,
      context: Context,
    ): Promise<AssistantMessage> => {
      systemPromptsSeen.push(context.systemPrompt);
      return assistantMessage({
        responseId: `summary-${systemPromptsSeen.length}`,
        stopReason: "stop",
        content: [{ type: "text", text: "Compacted summary." }],
      });
    };
    const backend = new LocalBackend({
      storageDir,
      executor: turnExecutor(),
      complete,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    await backend.updateAgent(agent.id, {
      compaction_settings: { mode: "sliding_window", prompt: customPrompt },
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "only message" }],
      } as ConversationMessageCreateBody),
    );

    // Fewer than 4 messages: sliding-window planning fails and compaction
    // falls back to full summarization. The user's custom prompt must
    // survive the automatic mode fallback.
    await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    expect(systemPromptsSeen).toHaveLength(1);
    expect(systemPromptsSeen[0]).toBe(customPrompt);

    await rm(storageDir, { recursive: true, force: true });
  });

  test("keeps custom compaction prompt when sliding window still exceeds the context window", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-fallback-overflow-"),
    );
    const customPrompt = "CUSTOM-SUMMARY-PROMPT: summarize as haiku";
    const systemPromptsSeen: Array<string | undefined> = [];
    const complete = async (
      _model: unknown,
      context: Context,
    ): Promise<AssistantMessage> => {
      systemPromptsSeen.push(context.systemPrompt);
      // A long summary keeps the post-compaction estimate above the tiny
      // configured context window, forcing the full-summarization fallback.
      return assistantMessage({
        responseId: `summary-${systemPromptsSeen.length}`,
        stopReason: "stop",
        content: [{ type: "text", text: "x".repeat(8000) }],
      });
    };
    const backend = new LocalBackend({
      storageDir,
      executor: turnExecutor(),
      complete,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({
      name: "Local",
      model_settings: { context_window_limit: 1000 },
    } as never);
    await backend.updateAgent(agent.id, {
      compaction_settings: { mode: "sliding_window", prompt: customPrompt },
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    for (const content of ["first", "second"]) {
      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content }],
        } as ConversationMessageCreateBody),
      );
    }

    // Sliding-window compaction runs with the custom prompt, but the result
    // still exceeds the context window, so compaction falls back to full
    // summarization. That fallback must keep the user's custom prompt too.
    const result = await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    expect(systemPromptsSeen).toHaveLength(2);
    expect(systemPromptsSeen[0]).toBe(customPrompt);
    expect(systemPromptsSeen[1]).toBe(customPrompt);
    expect(result).toMatchObject({
      num_messages_before: 4,
      num_messages_after: 1,
    });

    await rm(storageDir, { recursive: true, force: true });
  });

  test("leaves empty history unchanged when full compaction cannot reduce context", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-irreducible-"),
    );
    const complete = async (): Promise<AssistantMessage> =>
      assistantMessage({
        responseId: "irreducible-summary",
        stopReason: "stop",
        content: [{ type: "text", text: "Nothing to compact." }],
      });
    const backend = new LocalBackend({
      storageDir,
      executor: turnExecutor(),
      complete,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);

    await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    const messages = await backend.listConversationMessages(conversation.id, {
      agent_id: agent.id,
      order: "asc",
    } as never);
    expect(messages.getPaginatedItems()).toHaveLength(0);

    await rm(storageDir, { recursive: true, force: true });
  });

  test("context-pressure compaction treats irreducible context as a no-op", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-pressure-irreducible-"),
    );
    const complete = async (): Promise<AssistantMessage> =>
      assistantMessage({
        responseId: "pressure-irreducible-summary",
        stopReason: "stop",
        content: [{ type: "text", text: "Nothing to compact." }],
      });
    const backend = new LocalBackend({
      storageDir,
      executor: turnExecutor(),
      complete,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);

    // Pressure compaction runs after a completed response; an irreducible
    // context must not turn that successful turn into a failure.
    const compaction = await (
      backend as unknown as {
        compactForContextPressure: (
          input: unknown,
          pressure: unknown,
        ) => Promise<unknown>;
      }
    ).compactForContextPressure(
      { conversationId: conversation.id, agentId: agent.id },
      {
        contextTokens: 1,
        contextWindow: 1,
        phase: "post_turn",
        source: "usage",
      },
    );
    expect(compaction).toMatchObject({ uiMessages: [], summary: "" });

    const messages = await backend.listConversationMessages(conversation.id, {
      agent_id: agent.id,
      order: "asc",
    } as never);
    expect(messages.getPaginatedItems()).toHaveLength(0);

    await rm(storageDir, { recursive: true, force: true });
  });

  test("provider overflow drops an irreducible full summary and emits one warning", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-overflow-drop-"));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const backend = new LocalBackend({
        storageDir,
        executor: turnExecutor(),
        memfsEnabled: false,
        complete: async () =>
          assistantMessage({
            responseId: "large-summary",
            stopReason: "stop",
            content: [{ type: "text", text: "x".repeat(8000) }],
          }),
      });
      const agent = await backend.createAgent({
        name: "Local",
        system: "Keep this system prompt.",
        model_settings: { context_window_limit: 1000 },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const local = backend as unknown as {
        store: LocalStore;
        compactAfterContextOverflow: (
          input: unknown,
          error: unknown,
        ) => Promise<{
          summary: string;
          uiMessages: import("./local-message").LocalMessage[];
          stats: { context_tokens_after: number };
        }>;
      };
      const latest = {
        ...assistantMessage({
          responseId: "latest",
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall" as const,
              id: "call-1",
              name: "Shell",
              arguments: { command: "pwd" },
            },
          ],
        }),
        id: "latest",
      };
      local.store.compactConversationAll({
        conversationId: conversation.id,
        agentId: agent.id,
        summary: "x".repeat(8000),
        packedSummary: "x".repeat(8000),
        remainingMessages: [latest],
      });
      const result = await local.compactAfterContextOverflow(
        { conversationId: conversation.id, agentId: agent.id },
        new Error("context overflow"),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(result.summary);
      expect(result.summary).toContain("Warning: older messages were dropped");
      expect(result.uiMessages).toHaveLength(2);
      expect(result.uiMessages[1]).toEqual(latest);
      expect(
        result.uiMessages.filter((message) => message.metadata?.compaction),
      ).toHaveLength(1);
      expect(result.stats.context_tokens_after).toBeLessThan(1000);
      const notice = result.uiMessages[0];
      expect(notice?.role).toBe("user");
      expect(JSON.stringify(notice?.content)).toContain(
        "older messages were dropped",
      );
      expect(
        local.store.retrieveExecutionAgentRecord(conversation.id, agent.id)
          .system,
      ).toContain("Keep this system prompt.");
    } finally {
      warn.mockRestore();
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("commits a normal full compaction", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-compaction-progress-"),
    );
    const complete = async (): Promise<AssistantMessage> =>
      assistantMessage({
        responseId: "normal-summary",
        stopReason: "stop",
        content: [{ type: "text", text: "Compacted summary." }],
      });
    const backend = new LocalBackend({
      storageDir,
      executor: turnExecutor(),
      complete,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "remember this" }],
      } as ConversationMessageCreateBody),
    );

    const result = await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    expect(result).toMatchObject({
      num_messages_before: 2,
      num_messages_after: 1,
    });
    const messages = await backend.listConversationMessages(conversation.id, {
      agent_id: agent.id,
      order: "asc",
    } as never);
    expect(messages.getPaginatedItems()).toHaveLength(1);

    await rm(storageDir, { recursive: true, force: true });
  });
});
