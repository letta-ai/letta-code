import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";

async function firstConversationDir(storageDir: string): Promise<string> {
  const entries = await readdir(join(storageDir, "conversations"));
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const dir = join(storageDir, "conversations", entry);
    let raw: string;
    try {
      raw = await readFile(join(dir, "messages.jsonl"), "utf8");
    } catch {
      continue;
    }
    const rows = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    if (
      rows.some(
        (row) => row.type === "message" || Object.hasOwn(row, "content"),
      )
    ) {
      return dir;
    }
  }
  const firstEntry = entries[0];
  if (!firstEntry)
    throw new Error("Expected at least one conversation directory");
  return join(storageDir, "conversations", firstEntry);
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

function pageItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
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

describe("local backend mid-conversation memory updates", () => {
  test.each([
    ["deepseek/deepseek-v4-flash", true],
    ["zai/glm-5.3", true],
    ["anthropic/claude-fable-5-1", true],
    ["anthropic/claude-opus-5", true],
    ["anthropic/claude-sonnet-4-6", false],
    // exact allowlist: a hypothetical variant must not opt in by prefix
    ["anthropic/claude-opus-5-mini", false],
    // transports that do not append the update yet: must fall back to recompilation
    ["xai/grok-4.6", false],
    ["openai-codex/gpt-5.6-sol", false],
    ["ollama/qwen3.5:9b", false],
  ])(
    "memory change on %s uses mid-conversation update: %s",
    async (model, expectsMidConversation) => {
      const storageDir = await mkdtemp(join(tmpdir(), "local-backend-mid-"));
      const systemPrompts: string[] = [];
      const midConversationPrompts: Array<string | undefined> = [];
      const executor: HeadlessTurnExecutor = {
        async execute(input) {
          systemPrompts.push(input.systemPrompt ?? "");
          midConversationPrompts.push(input.midConversationSystemPrompt);
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
      const backend = new LocalBackend({ storageDir, executor });
      const agent = await backend.createAgent({
        name: "Local",
        model,
        system: "base {CORE_MEMORY}",
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as never);
      const initialSystemPrompt = await backend.recompileConversation(
        conversation.id,
        { agent_id: agent.id } as never,
      );
      const memoryDir = join(storageDir, "memfs", agent.id, "memory");
      await mkdir(join(memoryDir, "system"), { recursive: true });
      await writeFile(
        join(memoryDir, "system", "persona.md"),
        "---\ndescription: Persona\n---\nEdited persona.\n",
        "utf8",
      );
      execFileSync("git", ["add", "system/persona.md"], { cwd: memoryDir });
      execFileSync("git", ["commit", "-m", "test memory change"], {
        cwd: memoryDir,
      });

      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "first" }],
        } as ConversationMessageCreateBody),
      );

      if (expectsMidConversation) {
        // Prefix preserved: same system prompt, update appended as a message.
        expect(systemPrompts).toEqual([initialSystemPrompt]);
        expect(midConversationPrompts[0]).toContain("<memory_update>");
        expect(midConversationPrompts[0]).toContain("Edited persona.");
      } else {
        // Previous behaviour for providers without documented support.
        expect(systemPrompts[0]).not.toBe(initialSystemPrompt);
        expect(systemPrompts[0]).toContain("Edited persona.");
        expect(midConversationPrompts[0]).toBeUndefined();
      }
    },
  );

  test("recompiles cached system prompt after local compaction", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-compact-"));
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
    const complete = async (): Promise<AssistantMessage> =>
      assistantMessage({
        responseId: "summary-response",
        stopReason: "stop",
        content: [{ type: "text", text: "Compacted summary." }],
      });
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
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "first" }],
      } as ConversationMessageCreateBody),
    );
    expect(systemPrompts[0]).toContain("previous messages between you");
    const promptPath = join(
      await firstConversationDir(storageDir),
      "system-prompt.json",
    );
    const promptBefore = await readFile(promptPath, "utf8");

    await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    const entriesAfterCompaction = (
      await readFile(
        join(await firstConversationDir(storageDir), "messages.jsonl"),
        "utf8",
      )
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entriesAfterCompaction.map((entry) => entry.type)).toEqual([
      "session",
      "message",
      "message",
      "compaction",
    ]);
    const messageEntries = entriesAfterCompaction.filter(
      (entry) => entry.type === "message",
    );
    expect(
      messageEntries.map(
        (entry) => (entry.message as Record<string, unknown> | undefined)?.id,
      ),
    ).toEqual(["ui-msg-1", "ui-msg-2"]);
    expect(
      messageEntries.every(
        (entry) => entry.id !== (entry.message as Record<string, unknown>).id,
      ),
    ).toBe(true);
    const compactionEntry = entriesAfterCompaction.at(-1) as Record<
      string,
      unknown
    >;
    expect(compactionEntry).toMatchObject({
      type: "compaction",
      parentId: messageEntries.at(-1)?.id,
      summary: "Compacted summary.",
    });
    expect(
      (compactionEntry.message as Record<string, unknown> | undefined)?.id,
    ).toBe("ui-msg-3");

    const reloadedAfterCompaction = new LocalBackend({
      storageDir,
      executor,
      complete,
      memfsEnabled: false,
    });
    const activeAfterCompaction = pageItems(
      await reloadedAfterCompaction.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(activeAfterCompaction.map((message) => message.id)).toEqual([
      "ui-msg-3",
    ]);

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "after compaction" }],
      } as ConversationMessageCreateBody),
    );

    // Message count is bucketed, so the rendered prompt text may be identical
    // before and after; assert the recompilation itself: compaction must have
    // produced a NEW compiled record (compiledAt advances) for this conversation.
    const before = JSON.parse(promptBefore) as { compiledAt?: string };
    const after = JSON.parse(await readFile(promptPath, "utf8")) as {
      compiledAt?: string;
    };
    expect(before.compiledAt).toBeDefined();
    expect(after.compiledAt).toBeDefined();
    expect(new Date(after.compiledAt as string).getTime()).toBeGreaterThan(
      new Date(before.compiledAt as string).getTime(),
    );
  });
});
