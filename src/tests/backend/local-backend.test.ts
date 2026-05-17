import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ConversationMessageCreateBody } from "../../backend";
import type { PiStreamFunction } from "../../backend/dev/PiStreamAdapter";
import { createOrUpdateLocalProvider } from "../../backend/local";
import { LocalBackend } from "../../backend/local/LocalBackend";
import { emptyLocalUsage } from "../../backend/local/LocalMessage";
import { listLocalModels } from "../../backend/local/LocalModelConfig";
import {
  LocalTranscriptMigrationRequiredError,
  LocalTranscriptRepairRequiredError,
} from "../../backend/local/LocalStore";
import { migrateLocalBackendTranscripts } from "../../backend/local/transcriptMigration";

async function firstConversationDir(storageDir: string): Promise<string> {
  const entries = await readdir(join(storageDir, "conversations"));
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    const dir = join(storageDir, "conversations", entry);
    const raw = await readFile(join(dir, "messages.jsonl"), "utf8");
    if (raw.trim().length > 0) return dir;
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

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
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

function streamFromEvents(
  events: AssistantMessageEvent[],
  finalMessage: AssistantMessage,
): ReturnType<PiStreamFunction> {
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), {
    result: async () => finalMessage,
  });
}

describe("local backend pi transcript", () => {
  test("lists pi catalog models for configured zAI coding provider", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-pi-zai-"));
    await createOrUpdateLocalProvider({
      providerType: "zai_coding",
      providerName: "lc-zai-coding",
      apiKey: "dummy",
      storageDir,
    });

    const handles = (await listLocalModels(storageDir)).map(
      (model) => model.handle,
    );
    expect(handles).toContain("zai/glm-4.5-air");
    expect(handles).toContain("zai/glm-5.1");
  });

  test("does not list unconfigured local provider model guesses", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-unconfigured-local-"),
    );

    const handles = (await listLocalModels(storageDir)).map(
      (model) => model.handle,
    );
    expect(handles.some((handle) => handle.startsWith("ollama/"))).toBe(false);
    expect(handles.some((handle) => handle.startsWith("lmstudio/"))).toBe(
      false,
    );
    expect(handles.some((handle) => handle.startsWith("llama.cpp/"))).toBe(
      false,
    );
  });

  test("discovers configured LM Studio models from OpenAI-compatible catalog", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-lmstudio-discovery-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "lmstudio",
      providerName: "lc-lmstudio",
      apiKey: "not-needed",
      baseURL: "http://127.0.0.1:1234/v1",
      storageDir,
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      return new Response(
        JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(calls).toEqual(["http://127.0.0.1:1234/v1/models"]);
    expect(handles).toContain("lmstudio/openai/gpt-oss-20b");
    expect(handles).not.toContain("lmstudio/google/gemma-3n-e4b");
  });

  test("discovers configured llama.cpp models from OpenAI-compatible catalog", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-llama-cpp-discovery-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "llama_cpp",
      providerName: "lc-llama-cpp",
      apiKey: "not-needed",
      baseURL: "http://localhost:8080/v1",
      storageDir,
    });
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(handles).toContain("llama.cpp/local-model");
  });

  test("writes versioned pi transcript manifest for new local conversations", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-manifest-"),
    );
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "hello" }],
      } as ConversationMessageCreateBody),
    );

    const dir = await firstConversationDir(storageDir);
    const manifest = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      schema_version: 1,
      message_format: "pi-ai-message-jsonl",
      provider_stack: "pi-ai",
    });
    const messages = (await readFile(join(dir, "messages.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages.every((message) => "content" in message)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain('"parts"');

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "hello again" }],
      } as ConversationMessageCreateBody),
    );
    const manifestAfterSecondTurn = JSON.parse(
      await readFile(join(dir, "manifest.json"), "utf8"),
    );
    expect(manifestAfterSecondTurn).toEqual(manifest);
  });

  test("persists pi tool calls and sends tool results back through provider context", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-pi-tool-"));
    const contexts: Context[] = [];
    const stream: PiStreamFunction = (
      _model: Model<string>,
      context: Context,
      _options?: SimpleStreamOptions,
    ) => {
      contexts.push(context);
      if (contexts.length === 1) {
        const finalMessage = assistantMessage({
          responseId: "response-tool",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Let me inspect that." },
            { type: "thinking", thinking: "Need the README." },
            {
              type: "toolCall",
              id: "call-readme",
              name: "Read",
              arguments: { path: "README.md" },
            },
          ],
        });
        return streamFromEvents(
          [
            {
              type: "text_delta",
              contentIndex: 0,
              delta: "Let me inspect that.",
              partial: finalMessage,
            },
            {
              type: "thinking_delta",
              contentIndex: 1,
              delta: "Need the README.",
              partial: finalMessage,
            },
            {
              type: "toolcall_end",
              contentIndex: 2,
              toolCall: finalMessage.content[2] as Extract<
                AssistantMessage["content"][number],
                { type: "toolCall" }
              >,
              partial: finalMessage,
            },
            { type: "done", reason: "toolUse", message: finalMessage },
          ],
          finalMessage,
        );
      }

      const finalMessage = assistantMessage({
        responseId: "response-final",
        stopReason: "stop",
        content: [{ type: "text", text: "Tool result received." }],
      });
      return streamFromEvents(
        [
          {
            type: "text_delta",
            contentIndex: 0,
            delta: "Tool result received.",
            partial: finalMessage,
          },
          { type: "done", reason: "stop", message: finalMessage },
        ],
        finalMessage,
      );
    };
    const backend = new LocalBackend({
      storageDir,
      stream,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);

    const firstChunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "inspect the readme" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      firstChunks.map(
        (chunk) => (chunk as { message_type?: string }).message_type,
      ),
    ).toEqual([
      "assistant_message",
      "reasoning_message",
      "approval_request_message",
      "usage_statistics",
      "stop_reason",
    ]);

    const page = await backend.listConversationMessages(conversation.id, {
      agent_id: agent.id,
      order: "asc",
    } as never);
    expect(
      page.getPaginatedItems().map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "assistant_message",
      "reasoning_message",
      "approval_request_message",
    ]);

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: "call-readme",
                status: "success",
                tool_return: "README contents",
              },
            ],
          },
        ],
      } as never),
    );

    expect(contexts).toHaveLength(2);
    const secondContextMessages = contexts[1]?.messages ?? [];
    expect(secondContextMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-readme",
      content: [{ type: "text", text: "README contents" }],
    });
  });

  test("refuses to load unversioned non-empty transcripts with exact migration command", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-legacy-"),
    );
    const conversationDir = join(storageDir, "conversations", "legacy");
    await mkdir(conversationDir, { recursive: true });
    await writeFile(
      join(conversationDir, "conversation.json"),
      JSON.stringify({
        id: "local-conv-1",
        agent_id: "agent-local-default",
        in_context_message_ids: [],
      }),
    );
    await writeFile(
      join(conversationDir, "messages.jsonl"),
      `${JSON.stringify({ id: "ui-msg-1", role: "user", parts: [{ type: "text", text: "legacy" }] })}\n`,
    );

    expect(() => new LocalBackend({ storageDir, memfsEnabled: false })).toThrow(
      LocalTranscriptMigrationRequiredError,
    );
    expect(() => new LocalBackend({ storageDir, memfsEnabled: false })).toThrow(
      `letta local-backend migrate-transcripts --storage-dir "${storageDir}"`,
    );
  });

  test("refuses to load versioned transcripts with legacy UI rows and repairs them with migrate-transcripts", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-repair-"),
    );
    const conversationDir = join(storageDir, "conversations", "mismatched");
    await mkdir(conversationDir, { recursive: true });
    await writeFile(
      join(conversationDir, "conversation.json"),
      JSON.stringify({
        id: "local-conv-1",
        agent_id: "agent-local-default",
        in_context_message_ids: ["ui-msg-1"],
      }),
    );
    await writeFile(
      join(conversationDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        message_format: "pi-ai-message-jsonl",
        provider_stack: "pi-ai",
        created_at: new Date().toISOString(),
      })}\n`,
    );
    await writeFile(
      join(conversationDir, "messages.jsonl"),
      `${JSON.stringify({ id: "ui-msg-1", role: "user", parts: [{ type: "text", text: "legacy after manifest" }] })}\n`,
    );

    expect(() => new LocalBackend({ storageDir, memfsEnabled: false })).toThrow(
      LocalTranscriptRepairRequiredError,
    );
    expect(() => new LocalBackend({ storageDir, memfsEnabled: false })).toThrow(
      `letta local-backend migrate-transcripts --storage-dir "${storageDir}"`,
    );

    const result = migrateLocalBackendTranscripts({ storageDir });
    expect(result.converted).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(join(conversationDir, "manifest.json"), "utf8"),
    );
    expect(manifest.migrated_from).toBe(
      "versioned-pi-transcript-with-legacy-ui-message-rows",
    );
    const converted = JSON.parse(
      (await readFile(join(conversationDir, "messages.jsonl"), "utf8")).trim(),
    );
    expect(converted).toMatchObject({
      id: "ui-msg-1",
      role: "user",
      content: [{ type: "text", text: "legacy after manifest" }],
    });
    expect(converted.parts).toBeUndefined();
    expect(
      () => new LocalBackend({ storageDir, memfsEnabled: false }),
    ).not.toThrow();
  });

  test("migrates unversioned transcripts with a backup", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-migrate-"),
    );
    const conversationDir = join(storageDir, "conversations", "legacy");
    await mkdir(conversationDir, { recursive: true });
    await writeFile(
      join(conversationDir, "messages.jsonl"),
      `${[
        JSON.stringify({
          id: "ui-msg-1",
          role: "user",
          parts: [{ type: "text", text: "hi" }],
        }),
        JSON.stringify({
          id: "ui-msg-2",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "thinking" },
            { type: "text", text: "answer" },
            {
              type: "tool-Read",
              toolCallId: "call-1",
              state: "output-available",
              input: { path: "README.md" },
              output: "ok",
            },
          ],
        }),
      ].join("\n")}\n`,
    );

    const result = migrateLocalBackendTranscripts({ storageDir });
    expect(result.converted).toHaveLength(1);
    expect(result.converted[0]?.backupPath).toContain(
      "messages.jsonl.pre-pi-backup-",
    );
    const manifest = JSON.parse(
      await readFile(join(conversationDir, "manifest.json"), "utf8"),
    );
    expect(manifest.provider_stack).toBe("pi-ai");
    const converted = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { role: string });
    expect(converted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(converted)).toContain('"thinking"');
    expect(JSON.stringify(converted)).toContain('"toolCall"');
  });
});
