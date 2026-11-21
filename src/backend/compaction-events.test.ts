import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import { APIBackend } from "@/backend/backend";
import {
  type ConversationCompaction,
  onConversationCompacted,
} from "@/backend/compaction-events";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

const seen: ConversationCompaction[] = [];
let unsubscribe: (() => void) | null = null;

function record(): void {
  seen.length = 0;
  unsubscribe = onConversationCompacted((compaction) => seen.push(compaction));
}

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
});

function chunkStream(chunks: Array<Record<string, unknown>>) {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      yield* chunks;
    },
  };
}

describe("backend compaction events", () => {
  test("API manual compact reports the conversation only after it succeeds", async () => {
    record();
    let fail = true;
    const client = {
      conversations: {
        messages: {
          compact: async () => {
            if (fail) throw new Error("compact rejected");
            return { num_messages_before: 4, num_messages_after: 1 };
          },
        },
      },
    };
    const backend = new APIBackend({ getClient: async () => client as never });
    await expect(
      backend.compactConversationMessages("default", { agent_id: "agent-a" }),
    ).rejects.toThrow("compact rejected");
    expect(seen).toEqual([]);
    fail = false;
    await backend.compactConversationMessages("default", {
      agent_id: "agent-a",
    });
    expect(seen).toEqual([
      { backend, conversationId: "default", agentId: "agent-a" },
    ]);
  });

  test("API resumed conversation stream reports a summary_message when it arrives", async () => {
    record();
    const client = {
      conversations: {
        messages: {
          stream: async () =>
            chunkStream([
              { message_type: "assistant_message" },
              { message_type: "summary_message", summary: "compacted" },
            ]),
        },
      },
    };
    const backend = new APIBackend({ getClient: async () => client as never });
    const stream = await backend.streamConversationMessages("conv-1", {
      otid: "otid-1",
    } as never);
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    expect(seen).toEqual([]);
    await iterator.next();
    expect(seen).toEqual([{ backend, conversationId: "conv-1" }]);
    expect(stream.controller).toBeInstanceOf(AbortController);
  });

  test("local manual compact reports the conversation", async () => {
    record();
    const storageDir = await mkdtemp(join(tmpdir(), "compaction-events-"));
    try {
      const executor: HeadlessTurnExecutor = {
        async execute() {
          return chunkStream([
            { message_type: "assistant_message", content: "ok" },
            { message_type: "stop_reason", stop_reason: "end_turn" },
          ]) as unknown as Stream<LettaStreamingResponse>;
        },
      };
      const summary: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Compacted summary." }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5.5",
        responseId: "summary-1",
        usage: emptyLocalUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      };
      const backend = new LocalBackend({
        storageDir,
        executor,
        complete: async () => summary,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      for await (const _chunk of await backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: agent.id,
          messages: [{ role: "user", content: "hello" }],
        } as ConversationMessageCreateBody,
      )) {
        /* drain */
      }
      await backend.compactConversationMessages(conversation.id, {
        agent_id: agent.id,
      } as never);
      expect(seen).toEqual([
        { backend, conversationId: conversation.id, agentId: agent.id },
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
