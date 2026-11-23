import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
} from "@/backend/local/local-transcript";
import { countLocalTranscriptMessagesOutsideContext } from "@/backend/local/local-transcript-history";
import { TestDirectory } from "@/test-utils/test-fs";

const TIMESTAMP = "2026-11-17T00:00:00.000Z";

function message(id: string, text = id) {
  return { id, role: "user", content: [{ type: "text", text }] };
}

function messageEntry(id: string, parentId: string | null, text?: string) {
  return {
    type: "message",
    id: `entry-${id}-${text ?? ""}`,
    parentId,
    timestamp: TIMESTAMP,
    message: message(id, text),
  };
}

function withTranscript(rows: unknown[], run: (path: string) => void): void {
  const dir = new TestDirectory();
  try {
    run(
      dir.createFile(
        "messages.jsonl",
        `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      ),
    );
  } finally {
    dir.cleanup();
  }
}

describe("countLocalTranscriptMessagesOutsideContext", () => {
  test("counts each message outside context once, including summaries", () => {
    const rows = [
      { type: "session", version: 3, id: "s", timestamp: TIMESTAMP, cwd: "/" },
      messageEntry("m1", null),
      messageEntry("m2", "entry-m1-"),
      messageEntry("m2", "entry-m2-", "edited"),
      {
        type: "compaction",
        id: "entry-summary-1",
        parentId: "entry-m2-edited",
        timestamp: TIMESTAMP,
        summary: "first summary",
        firstKeptEntryId: null,
        tokensBefore: 10,
        message: message("summary-1"),
      },
      messageEntry("m3", "entry-summary-1"),
      {
        type: "compaction",
        id: "entry-summary-2",
        parentId: "entry-m3-",
        timestamp: TIMESTAMP,
        summary: "second summary",
        firstKeptEntryId: "entry-m3-",
        tokensBefore: 10,
        message: message("summary-2"),
      },
    ];
    withTranscript(rows, (path) => {
      expect(
        countLocalTranscriptMessagesOutsideContext(
          path,
          LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
          ["summary-2", "m3"],
        ),
      ).toBe(3);
    });
  });

  test("reads legacy message rows", () => {
    withTranscript([message("m1"), message("m2"), message("m3")], (path) => {
      expect(
        countLocalTranscriptMessagesOutsideContext(
          path,
          LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
          ["m3"],
        ),
      ).toBe(2);
    });
  });

  test("treats an empty in-context list as everything in context", () => {
    withTranscript([messageEntry("m1", null)], (path) => {
      expect(
        countLocalTranscriptMessagesOutsideContext(
          path,
          LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
          [],
        ),
      ).toBe(0);
    });
  });

  test("returns 0 for a missing transcript", () => {
    expect(
      countLocalTranscriptMessagesOutsideContext(
        join(tmpdir(), "missing-local-transcript", "messages.jsonl"),
        LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
        ["m1"],
      ),
    ).toBe(0);
  });
});

function lettaStreamFromChunks(
  chunks: LettaStreamingResponse[],
): Stream<LettaStreamingResponse> {
  return {
    controller: new AbortController(),
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  } as unknown as Stream<LettaStreamingResponse>;
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
  }
}

describe("local system prompt recall count", () => {
  test("reports the messages compaction took out of context", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-recall-count-"));
    const systemPrompts: string[] = [];
    const executor: HeadlessTurnExecutor = {
      async execute(input) {
        systemPrompts.push(input.systemPrompt ?? "");
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
    const complete = async (): Promise<AssistantMessage> => ({
      role: "assistant",
      content: [{ type: "text", text: "Compacted summary." }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      responseId: "summary-response",
      usage: emptyLocalUsage(),
      stopReason: "stop",
      timestamp: Date.now(),
    });
    try {
      const backend = new LocalBackend({
        storageDir,
        executor,
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Local",
        system: "base {CORE_MEMORY}",
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const turn = async (content: string) =>
        drain(
          await backend.createConversationMessageStream(conversation.id, {
            agent_id: agent.id,
            messages: [{ role: "user", content }],
          } as ConversationMessageCreateBody),
        );
      const compact = () =>
        backend.compactConversationMessages(conversation.id, {
          agent_id: agent.id,
        } as never);

      await turn("first");
      await compact();
      await turn("second");
      await compact();
      await turn("third");

      expect(systemPrompts.map(recallLine)).toEqual([
        "- 0 previous messages between you and the user are stored in recall memory",
        "- 2 previous messages between you and the user are stored in recall memory",
        "- 5 previous messages between you and the user are stored in recall memory",
      ]);

      const reloaded = new LocalBackend({
        storageDir,
        executor,
        complete,
        memfsEnabled: false,
      });
      const recompiled = await reloaded.recompileConversation(conversation.id, {
        agent_id: agent.id,
        dry_run: true,
      } as never);
      expect(recallLine(recompiled)).toBe(
        "- 5 previous messages between you and the user are stored in recall memory",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});

function recallLine(prompt: string): string | undefined {
  return prompt
    .split("\n")
    .find((line) => line.includes("stored in recall memory"));
}
