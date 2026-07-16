import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type { ConversationMessageCreateBody } from "@/backend";
import type { HeadlessTurnExecutor } from "@/backend/dev/headless-turn-executor";
import {
  clearRegisteredPiProviders,
  registerPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { createOrUpdateLocalProvider } from "@/backend/local";
import { LocalBackend } from "@/backend/local/local-backend";
import { emptyLocalUsage } from "@/backend/local/local-message";
import { LOCAL_REPAIRED_TOOL_RESULT_TEXT_MAX_CHARS } from "@/backend/local/local-message-projection";
import { listLocalModels } from "@/backend/local/local-model-config";
import {
  LocalStore,
  LocalTranscriptMigrationRequiredError,
  LocalTranscriptRepairRequiredError,
} from "@/backend/local/local-store";
import { LOCAL_BACKEND_DIR_ENV } from "@/backend/local/paths";
import { migrateLocalBackendTranscripts } from "@/backend/local/transcript-migration";
import { listLocalAgentsFromDisk } from "@/cli/helpers/local-agent-listing";

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

function localConversationDir(
  storageDir: string,
  conversationId: string,
): string {
  return join(
    storageDir,
    "conversations",
    Buffer.from(`conversation:${conversationId}`).toString("base64url"),
  );
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

function pageItems<T>(value: T[] | { getPaginatedItems(): T[] }): T[] {
  return Array.isArray(value) ? value : value.getPaginatedItems();
}

function localAgentListIds(page: unknown): string[] {
  const items = (page as { items?: Array<{ id: string }> }).items;
  return Array.isArray(items) ? items.map((agent) => agent.id) : [];
}

async function withEnv<T>(
  updates: Record<string, string | undefined>,
  run: () => Promise<T>,
): Promise<T> {
  const previous = Object.fromEntries(
    Object.keys(updates).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
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

describe("local backend pi transcript", () => {
  afterEach(() => {
    clearRegisteredPiProviders();
  });

  test("uses wall-clock timestamps for new local conversations and messages", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-time-"));
    const before = Date.now() - 1_000;
    const executor: HeadlessTurnExecutor = {
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
    const backend = new LocalBackend({
      storageDir,
      executor,
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

    const after = Date.now() + 1_000;
    const conversations = (await backend.listConversations({
      agent_id: agent.id,
    } as never)) as Array<{ last_message_at?: string | null }>;
    const messages = pageItems(
      await backend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    const timestamps = [
      conversation.created_at,
      conversations[0]?.last_message_at,
      messages[0]?.date,
      messages.at(-1)?.date,
    ];
    for (const timestamp of timestamps) {
      expect(typeof timestamp).toBe("string");
      const parsed = Date.parse(timestamp ?? "");
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after);
    }
  });

  test("rejects updates to the virtual default conversation", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-default-conversation-update-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });

      expect(() =>
        backend.updateConversation("default", {
          summary: "Default rename",
        } as never),
      ).toThrow("Default conversation cannot be updated");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("refreshes conversation metadata changed by another local backend process", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-external-conversation-update-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        summary: "Original title",
      } as never);

      const conversationPath = join(
        localConversationDir(storageDir, conversation.id),
        "conversation.json",
      );
      const externalRecord = JSON.parse(
        await readFile(conversationPath, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        conversationPath,
        `${JSON.stringify(
          {
            ...externalRecord,
            summary: "Desktop rename",
            updated_at: "2026-06-15T23:00:00.000Z",
          },
          null,
          2,
        )}\n`,
      );
      const futureMtime = new Date(Date.now() + 5_000);
      await utimes(conversationPath, futureMtime, futureMtime);

      const retrieved = (await backend.retrieveConversation(
        conversation.id,
      )) as { summary?: string | null };
      expect(retrieved.summary).toBe("Desktop rename");

      const listed = (await backend.listConversations({
        agent_id: agent.id,
      } as never)) as Array<{ id: string; summary?: string | null }>;
      expect(listed.find((item) => item.id === conversation.id)?.summary).toBe(
        "Desktop rename",
      );

      await backend.updateConversation(conversation.id, {
        last_message_at: "2026-06-15T23:01:00.000Z",
      } as never);
      const persisted = JSON.parse(
        await readFile(conversationPath, "utf8"),
      ) as Record<string, unknown>;
      expect(persisted.summary).toBe("Desktop rename");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("hides local hidden agents from backend and disk listings", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-hidden-agents-"),
    );
    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const visible = await backend.createAgent({ name: "Visible" } as never);
      const hidden = await backend.createAgent({
        name: "Hidden",
        hidden: true,
      } as never);
      const legacySubagentId = "agent-local-legacy-subagent";
      const legacySubagentPath = join(
        storageDir,
        "agents",
        `${Buffer.from(legacySubagentId).toString("base64url")}.json`,
      );
      await writeFile(
        legacySubagentPath,
        `${JSON.stringify(
          {
            id: legacySubagentId,
            name: "Legacy subagent",
            description: null,
            system: "",
            tags: [
              "origin:letta-code",
              "role:subagent",
              "type:general-purpose",
            ],
            model: "local/default",
            model_settings: {},
          },
          null,
          2,
        )}\n`,
      );

      expect((hidden as { hidden?: boolean }).hidden).toBe(true);

      const listedIds = localAgentListIds(
        await backend.listAgents({ limit: 10 } as never),
      );
      expect(listedIds).toContain(visible.id);
      expect(listedIds).not.toContain(hidden.id);

      await withEnv({ [LOCAL_BACKEND_DIR_ENV]: storageDir }, async () => {
        const diskListedIds = listLocalAgentsFromDisk().map(
          (agent) => agent.id,
        );
        expect(diskListedIds).toContain(visible.id);
        expect(diskListedIds).not.toContain(hidden.id);
        expect(diskListedIds).not.toContain(legacySubagentId);
      });

      const reloaded = new LocalBackend({ storageDir, memfsEnabled: false });
      const reloadedListedIds = localAgentListIds(
        await reloaded.listAgents({ limit: 10 } as never),
      );
      expect(reloadedListedIds).toContain(visible.id);
      expect(reloadedListedIds).not.toContain(hidden.id);
      expect(reloadedListedIds).not.toContain(legacySubagentId);

      const retrievedHidden = await reloaded.retrieveAgent(hidden.id);
      expect((retrievedHidden as { hidden?: boolean }).hidden).toBe(true);
      const retrievedLegacySubagent =
        await reloaded.retrieveAgent(legacySubagentId);
      expect((retrievedLegacySubagent as { hidden?: boolean }).hidden).toBe(
        true,
      );

      const migratedLegacySubagent = JSON.parse(
        await readFile(legacySubagentPath, "utf8"),
      ) as Record<string, unknown>;
      expect(migratedLegacySubagent.hidden).toBe(true);

      await withEnv({ [LOCAL_BACKEND_DIR_ENV]: storageDir }, async () => {
        const diskListedIds = listLocalAgentsFromDisk().map(
          (agent) => agent.id,
        );
        expect(diskListedIds).toContain(visible.id);
        expect(diskListedIds).not.toContain(hidden.id);
        expect(diskListedIds).not.toContain(legacySubagentId);
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("repairs legacy synthetic transcript timestamps from manifest and file mtime", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-time-"));
    const agentId = "agent-local-default";
    const conversationId = "local-conv-old";
    const conversationDir = join(
      storageDir,
      "conversations",
      `${conversationId}--${agentId}`,
    );
    const createdAt = "2026-05-22T12:00:00.000Z";
    const activeAt = "2026-05-22T13:00:00.000Z";
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", `${agentId}.json`),
      `${JSON.stringify({
        id: agentId,
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "openai/gpt-5-mini",
        model_settings: { model: "openai/gpt-5-mini" },
      })}\n`,
    );
    await mkdir(conversationDir, { recursive: true });
    await writeFile(
      join(conversationDir, "conversation.json"),
      `${JSON.stringify({
        id: conversationId,
        agent_id: agentId,
        created_at: "2026-01-01T00:00:01.000Z",
        updated_at: "2026-01-01T00:00:02.000Z",
        last_message_at: "2026-01-01T00:00:02.000Z",
        in_context_message_ids: ["local-ui-msg-1", "local-ui-msg-2"],
      })}\n`,
    );
    await writeFile(
      join(conversationDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        message_format: "pi-ai-message-jsonl",
        provider_stack: "pi-ai",
        created_at: createdAt,
      })}\n`,
    );
    const messagesPath = join(conversationDir, "messages.jsonl");
    const transcriptRows = [
      {
        id: "local-ui-msg-1",
        role: "user",
        content: [{ type: "text", text: "old" }],
        timestamp: Date.parse("2026-01-01T00:00:01.000Z"),
        metadata: {
          created_at: "2026-01-01T00:00:01.000Z",
          updated_at: "2026-01-01T00:00:01.000Z",
          agent_id: agentId,
          conversation_id: conversationId,
        },
      },
      {
        id: "local-ui-msg-2",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        api: "local",
        provider: "local",
        model: "local",
        usage: emptyLocalUsage(),
        stopReason: "stop",
        timestamp: Date.parse("2026-01-01T00:00:02.000Z"),
        metadata: {
          created_at: "2026-01-01T00:00:02.000Z",
          updated_at: "2026-01-01T00:00:02.000Z",
          agent_id: agentId,
          conversation_id: conversationId,
        },
      },
    ].map((message) => JSON.stringify(message));
    await writeFile(messagesPath, `${transcriptRows.join("\n")}\n`);
    await utimes(messagesPath, new Date(activeAt), new Date(activeAt));

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const messages = pageItems(
      await backend.listConversationMessages(conversationId, {
        agent_id: agentId,
        order: "asc",
      } as never),
    );
    const conversations = (await backend.listConversations({
      agent_id: agentId,
    } as never)) as Array<{
      created_at?: string | null;
      updated_at?: string | null;
      last_message_at?: string | null;
    }>;

    expect(conversations[0]?.created_at).toBe(createdAt);
    expect(conversations[0]?.updated_at).toBe(activeAt);
    expect(conversations[0]?.last_message_at).toBe(activeAt);
    expect(messages[0]?.date).toBe(createdAt);
    expect(messages.at(-1)?.date).toBe(activeAt);
  });

  test("loads bounded transcript tails without parsing the full jsonl", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-tail-"));
    const agentId = "agent-local-default";
    const conversationId = "local-conv-tail";
    const conversationDir = join(storageDir, "conversations", "tail");
    const messageIds = Array.from({ length: 120 }, (_, i) =>
      i === 119 ? "ui-msg-latest" : `ui-msg-${i}`,
    );
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", `${agentId}.json`),
      `${JSON.stringify({
        id: agentId,
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "openai/gpt-5-mini",
        model_settings: { model: "openai/gpt-5-mini" },
      })}\n`,
    );
    await mkdir(conversationDir, { recursive: true });
    await writeFile(
      join(conversationDir, "conversation.json"),
      `${JSON.stringify({
        id: conversationId,
        agent_id: agentId,
        created_at: "2026-05-22T12:00:00.000Z",
        updated_at: "2026-05-22T13:00:00.000Z",
        last_message_at: "2026-05-22T13:00:00.000Z",
        in_context_message_ids: messageIds,
      })}\n`,
    );
    await writeFile(
      join(conversationDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 1,
        message_format: "pi-ai-message-jsonl",
        provider_stack: "pi-ai",
        created_at: "2026-05-22T12:00:00.000Z",
      })}\n`,
    );

    const rows = ["{ definitely not json }"];
    for (let i = 0; i < 120; i += 1) {
      const id = messageIds[i];
      rows.push(
        JSON.stringify({
          id,
          role: i % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: "text",
              text: `${i === 119 ? "latest" : "older"} ${"x".repeat(2048)}`,
            },
          ],
          ...(i === 119
            ? {}
            : {
                metadata: {
                  created_at: new Date(
                    Date.UTC(2026, 4, 22, 12, i),
                  ).toISOString(),
                  updated_at: new Date(
                    Date.UTC(2026, 4, 22, 12, i),
                  ).toISOString(),
                  agent_id: agentId,
                  conversation_id: conversationId,
                },
              }),
        }),
      );
    }
    await writeFile(
      join(conversationDir, "messages.jsonl"),
      `${rows.join("\n")}\n`,
    );

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const conversation = await backend.retrieveConversation(conversationId);
    expect(conversation.in_context_message_ids).toEqual(messageIds);
    const messages = pageItems(
      await backend.listConversationMessages(conversationId, {
        agent_id: agentId,
        order: "desc",
        limit: 1,
      } as never),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.id).toBe("ui-msg-latest");
    expect(messages[0]?.date).toBe("2026-01-01T00:02:00.000Z");

    const backendForDirectLookup = new LocalBackend({
      storageDir,
      memfsEnabled: false,
    });
    const latestVariants =
      await backendForDirectLookup.retrieveMessage("ui-msg-latest");
    expect(latestVariants[0]?.id).toBe("ui-msg-latest");
    expect(latestVariants[0]?.date).toBe("2026-01-01T00:02:00.000Z");
  });

  test("fork skips ids already on disk from a separate LocalStore instance", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-store-fork-collision-"),
    );
    const agentId = "agent-fork";
    const sourceId = "conv-source";
    const existingId = "conv-existing";

    // Store A creates a source conversation and an existing conversation that
    // occupies the next seq slot, simulating a second LocalStore process that
    // wrote a conversation to the shared storage directory.
    const storeA = new LocalStore(agentId, { storageDir });
    storeA.appendTurnInput(sourceId, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    });
    storeA.appendTurnInput(existingId, {
      agent_id: agentId,
      messages: [{ role: "user", content: "existing" }],
    });

    // Store B loads from the same storage dir — it sees both conversations and
    // sets conversationSeq to the max existing value.  A fork from Store B
    // must not clobber the existing conversation even if its raw seq would
    // land on that slot.
    const storeB = new LocalStore(agentId, { storageDir });
    const { id: forkedId } = storeB.forkConversation(sourceId);

    // The fork must not reuse any id that already exists on disk.
    expect(forkedId).not.toBe(sourceId);
    expect(forkedId).not.toBe(existingId);

    // The existing conversation must still be intact.
    const existing = storeB.retrieveConversation(existingId);
    expect(existing.id).toBe(existingId);
  });

  test("interrupt rolls back unpersisted partial assistant message before reload", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-store-interrupt-"));
    const agentId = "agent-interrupt";
    const conversationId = "conv-interrupt";

    const store = new LocalStore(agentId, { storageDir });
    store.appendTurnInput(conversationId, {
      agent_id: agentId,
      messages: [{ role: "user", content: "hello" }],
    });
    store.appendStreamChunk(conversationId, agentId, {
      message_type: "assistant_message",
      content: [{ type: "text", text: "partial" }],
    } as LettaStreamingResponse);

    const conversationBeforeReload = store.retrieveConversation(conversationId);
    const partialAssistantId =
      conversationBeforeReload.in_context_message_ids?.at(-1);
    expect(partialAssistantId).toBe("ui-msg-2");

    store.settleInterruptedToolCalls(conversationId, { agentId });

    const reloaded = new LocalStore(agentId, { storageDir });
    const conversationAfterReload =
      reloaded.retrieveConversation(conversationId);
    expect(conversationAfterReload.in_context_message_ids).not.toContain(
      partialAssistantId,
    );
    expect(reloaded.retrieveMessage(partialAssistantId ?? "")).toEqual([]);
  });

  test("recompiles cached system prompt when committed memory changes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-cache-"));
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
    const backend = new LocalBackend({
      storageDir,
      executor,
    });
    const agent = await backend.createAgent({
      name: "Local",
      system: "base {CORE_MEMORY}",
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    const memoryDir = join(storageDir, "memfs", agent.id, "memory");
    await mkdir(join(memoryDir, "system"), { recursive: true });
    await writeFile(
      join(memoryDir, "system", "persona.md"),
      "---\ndescription: Persona\n---\nChanged but not explicitly recompiled.\n",
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

    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).toContain(
      "Changed but not explicitly recompiled.",
    );
  });

  test("uses mid-conversation system prompt for Opus 4.8 memory changes", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-opus-"));
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
      model: "anthropic/claude-opus-4-8",
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
      "---\ndescription: Persona\n---\nEdited Opus persona.\n",
      "utf8",
    );
    execFileSync("git", ["add", "system/persona.md"], { cwd: memoryDir });
    execFileSync("git", ["commit", "-m", "test opus memory change"], {
      cwd: memoryDir,
    });

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "first" }],
      } as ConversationMessageCreateBody),
    );
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "second" }],
      } as ConversationMessageCreateBody),
    );

    expect(systemPrompts).toEqual([initialSystemPrompt, initialSystemPrompt]);
    expect(midConversationPrompts[0]).toContain("<memory_update>");
    expect(midConversationPrompts[0]).toContain("Edited Opus persona.");
    expect(midConversationPrompts[1]).toBeUndefined();
  });

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
    expect(systemPrompts[0]).toContain("- 0 previous messages");

    await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    const conversationDir = await firstConversationDir(storageDir);
    const entriesAfterCompaction = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
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

    expect(systemPrompts[1]).toContain("- 1 previous messages");
    expect(systemPrompts[1]).not.toBe(systemPrompts[0]);
  });

  test("emits compact mod-event hooks around local compaction", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-compact-hooks-"),
    );
    const executor: HeadlessTurnExecutor = {
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
    const starts: Array<{ trigger: string; conversationId: string | null }> =
      [];
    const ends: Array<{
      trigger: string;
      messagesBefore: number;
      messagesAfter: number;
      contextTokensBefore: number;
      contextTokensAfter: number;
    }> = [];
    backend.setModEventHooks({
      onCompactStart: (info) => {
        starts.push({
          trigger: info.trigger,
          conversationId: info.conversationId,
        });
      },
      onCompactEnd: (info) => {
        ends.push({
          trigger: info.trigger,
          messagesBefore: info.messagesBefore,
          messagesAfter: info.messagesAfter,
          contextTokensBefore: info.contextTokensBefore,
          contextTokensAfter: info.contextTokensAfter,
        });
      },
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

    await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    expect(starts).toEqual([
      { trigger: "manual", conversationId: conversation.id },
    ]);
    expect(ends).toHaveLength(1);
    expect(ends[0]?.trigger).toBe("manual");
    // Compaction never increases the message count.
    expect(ends[0]?.messagesBefore).toBeGreaterThanOrEqual(
      ends[0]?.messagesAfter ?? 0,
    );
    expect(ends[0]?.messagesAfter ?? 0).toBeGreaterThan(0);
    expect(ends[0]?.contextTokensBefore ?? -1).toBeGreaterThanOrEqual(0);
    expect(ends[0]?.contextTokensAfter ?? -1).toBeGreaterThanOrEqual(0);
  });

  test("a throwing compact hook does not break compaction", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-compact-hook-throws-"),
    );
    const executor: HeadlessTurnExecutor = {
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
    backend.setModEventHooks({
      onCompactStart: () => {
        throw new Error("start hook boom");
      },
      onCompactEnd: () => {
        throw new Error("end hook boom");
      },
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

    const result = await backend.compactConversationMessages(conversation.id, {
      agent_id: agent.id,
    } as never);

    expect(result.summary).toBe("Compacted summary.");
  });

  test("compaction follows the conversation model override, not the agent base", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-compact-model-"),
    );
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "anthropic",
        providerName: "lc-anthropic",
        apiKey: "secret-key",
      });

      const executor: HeadlessTurnExecutor = {
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

      let summarizerModelId: string | undefined;
      const complete = async (
        ...args: unknown[]
      ): Promise<AssistantMessage> => {
        summarizerModelId = (args[0] as { id?: string } | undefined)?.id;
        return assistantMessage({
          responseId: "summary-response",
          stopReason: "stop",
          content: [{ type: "text", text: "Compacted summary." }],
        });
      };

      const backend = new LocalBackend({
        storageDir,
        executor,
        complete,
        memfsEnabled: false,
      });
      const agent = await backend.createAgent({
        name: "Local",
        model: "anthropic/claude-fable-5",
        model_settings: { provider_type: "anthropic" },
      } as never);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        model: "anthropic/claude-sonnet-4-6",
        model_settings: { provider_type: "anthropic" },
      } as never);

      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content: "first" }],
        } as ConversationMessageCreateBody),
      );

      await backend.compactConversationMessages(conversation.id, {
        agent_id: agent.id,
      } as never);

      // Agent base model is Fable; the conversation override is Sonnet 4.6.
      // Compaction (and its summarizer) must follow the conversation, not the
      // agent base model.
      expect(summarizerModelId).toBe("claude-sonnet-4-6");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

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
    const zaiHandles = handles.filter((handle) => handle.startsWith("zai/"));
    expect(zaiHandles[0]).toBe("zai/glm-5.2");
    expect(handles).toContain("zai/glm-4.5-air");
    expect(handles).toContain("zai/glm-5.2");
    expect(handles).toContain("zai/glm-5.1");
  });

  test("lists Fable 5 from the configured Anthropic pi catalog", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-anthropic-fable-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "dummy",
      storageDir,
    });

    const fable = (await listLocalModels(storageDir)).find(
      (model) => model.handle === "anthropic/claude-fable-5",
    );
    expect(fable?.max_context_window).toBe(1_000_000);
  });

  test("lists pi catalog context windows for configured OpenRouter models", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-openrouter-context-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey: "dummy",
      storageDir,
    });

    const kimi = (await listLocalModels(storageDir)).find(
      (model) => model.handle === "openrouter/moonshotai/kimi-k2.6",
    );
    expect(kimi?.max_context_window).toBe(
      getModel("openrouter", "moonshotai/kimi-k2.6")?.contextWindow,
    );
  });

  test("does not list unconfigured local provider model guesses", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-unconfigured-local-"),
    );
    const fetchImpl = (async () =>
      new Response("not found", { status: 404 })) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);
    expect(handles.some((handle) => handle.startsWith("ollama/"))).toBe(false);
    expect(handles.some((handle) => handle.startsWith("lmstudio/"))).toBe(
      false,
    );
    expect(handles.some((handle) => handle.startsWith("llama.cpp/"))).toBe(
      false,
    );
  });

  test("auto-detects reachable local model endpoints without saved providers", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-autodetect-local-"),
    );
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (url === "http://localhost:11434/api/tags") {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url === "http://127.0.0.1:1234/v1/models") {
        return new Response(
          JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(calls).toEqual(
      expect.arrayContaining([
        "http://localhost:11434/v1/models",
        "http://localhost:11434/api/tags",
        "http://127.0.0.1:1234/v1/models",
        "http://localhost:8080/v1/models",
      ]),
    );
    expect(handles).toContain("ollama/qwen2.5-coder:7b");
    expect(handles).toContain("lmstudio/openai/gpt-oss-20b");
    expect(handles.some((handle) => handle.startsWith("llama.cpp/"))).toBe(
      false,
    );
  });

  test("auto-detects reachable local model endpoints alongside saved providers", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-autodetect-with-provider-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "anthropic",
      providerName: "lc-anthropic",
      apiKey: "dummy",
      storageDir,
    });
    const fetchImpl = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "http://127.0.0.1:1234/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "local-model" }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(handles).toContain("anthropic/claude-opus-4-7");
    expect(handles).toContain("lmstudio/local-model");
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
      if (url === "http://127.0.0.1:1234/v1/models") {
        return new Response(
          JSON.stringify({ data: [{ id: "openai/gpt-oss-20b" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(calls).toEqual(
      expect.arrayContaining(["http://127.0.0.1:1234/v1/models"]),
    );
    expect(handles).toContain("lmstudio/openai/gpt-oss-20b");
    expect(handles).not.toContain("lmstudio/google/gemma-3n-e4b");
  });

  test("discovers configured Ollama models without adding guessed defaults", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-ollama-discovery-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "ollama",
      providerName: "lc-ollama",
      apiKey: "not-needed",
      baseURL: "http://localhost:11434/v1",
      storageDir,
    });
    const calls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (url.endsWith("/v1/models")) {
        return new Response("not found", { status: 404 });
      }
      return new Response(
        JSON.stringify({ models: [{ name: "qwen2.5-coder:7b" }] }),
        { headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(calls).toEqual(
      expect.arrayContaining([
        "http://localhost:11434/v1/models",
        "http://localhost:11434/api/tags",
      ]),
    );
    expect(handles).toContain("ollama/qwen2.5-coder:7b");
    expect(handles).not.toContain("ollama/llama2");
  });

  test("uses mod-registered context windows for local agent state", async () => {
    registerPiProvider("lmstudio", {
      baseUrl: "http://localhost:8000/v1",
      apiKey: "not-needed",
      api: "openai-completions",
      models: [
        {
          id: "gemma-4-26B-A4B-it-oQ6",
          name: "Gemma 4 VLM",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 8192,
        },
      ],
    });
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-registered-context-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "lmstudio",
      providerName: "lc-lmstudio",
      apiKey: "not-needed",
      baseURL: "http://127.0.0.1:1234/v1",
      storageDir,
    });

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const agent = await backend.createAgent({ name: "Local" } as never);

    expect(agent.model).toBe("lmstudio/gemma-4-26B-A4B-it-oQ6");
    expect(
      (agent as { llm_config?: { context_window?: number } }).llm_config
        ?.context_window,
    ).toBe(256000);
    expect(
      (agent as { llm_config?: { max_tokens?: number } }).llm_config
        ?.max_tokens,
    ).toBe(8192);
  });

  test("resets persisted output-token settings when switching local models", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-model-token-reset-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "openrouter",
      providerName: "lc-openrouter",
      apiKey: "dummy",
      storageDir,
    });

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const agent = await backend.createAgent({
      name: "Local",
      model: "openrouter/deepseek/deepseek-v4-pro",
      model_settings: {
        provider_type: "openrouter",
        max_output_tokens: 384000,
      },
      max_tokens: 384000,
      context_window_limit: 1048576,
    } as never);

    const updated = await backend.updateAgent(agent.id, {
      model: "openrouter/moonshotai/kimi-k2.6",
      model_settings: {
        provider_type: "openrouter",
        parallel_tool_calls: true,
      },
    } as never);

    const kimi = getModel("openrouter", "moonshotai/kimi-k2.6");
    expect(updated.model).toBe("openrouter/moonshotai/kimi-k2.6");
    expect(
      (updated as { llm_config?: { max_tokens?: number } }).llm_config
        ?.max_tokens,
    ).toBe(kimi?.maxTokens);
    expect(
      (updated as { llm_config?: { context_window?: number } }).llm_config
        ?.context_window,
    ).toBe(kimi?.contextWindow);
    expect(
      (updated.model_settings as Record<string, unknown>).max_output_tokens,
    ).toBeUndefined();
  });

  test("projects legacy local 128k defaults through registered model metadata", async () => {
    registerPiProvider("lmstudio", {
      baseUrl: "http://localhost:8000/v1",
      apiKey: "not-needed",
      api: "openai-completions",
      models: [
        {
          id: "gemma-4-26B-A4B-it-oQ6",
          name: "Gemma 4 VLM",
          reasoning: true,
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256000,
          maxTokens: 8192,
        },
      ],
    });
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-legacy-context-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "lmstudio",
      providerName: "lc-lmstudio",
      apiKey: "not-needed",
      baseURL: "http://127.0.0.1:1234/v1",
      storageDir,
    });
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", "agent-local-default.json"),
      JSON.stringify(
        {
          id: "agent-local-default",
          name: "Letta Code",
          description: null,
          system: "",
          tags: [],
          model: "lmstudio/gemma-4-26B-A4B-it-oQ6",
          model_settings: {
            provider_type: "lmstudio",
            context_window_limit: 128000,
          },
        },
        null,
        2,
      ),
    );

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    const agent = await backend.retrieveAgent("agent-local-default");

    expect(
      (agent as { llm_config?: { context_window?: number } }).llm_config
        ?.context_window,
    ).toBe(256000);
  });

  test("discovers configured Ollama Cloud models from OpenAI-compatible catalog", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-ollama-cloud-discovery-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "ollama_cloud",
      providerName: "lc-ollama-cloud",
      apiKey: "ollama-key",
      storageDir,
    });
    const calls: string[] = [];
    const captured: { authorization?: string | null } = {};
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      calls.push(url);
      if (url === "https://ollama.com/v1/models") {
        captured.authorization = new Headers(init?.headers).get(
          "Authorization",
        );
        return new Response(
          JSON.stringify({ data: [{ id: "rnj-1:8b" }, { id: "glm-5.1" }] }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const handles = (
      await listLocalModels(storageDir, { fetch: fetchImpl })
    ).map((model) => model.handle);

    expect(calls).toEqual(
      expect.arrayContaining(["https://ollama.com/v1/models"]),
    );
    expect(captured.authorization).toBe("Bearer ollama-key");
    expect(handles).toContain("ollama-cloud/rnj-1:8b");
    expect(handles).toContain("ollama-cloud/glm-5.1");
    expect(handles).not.toContain("ollama-cloud/gpt-oss:20b");
    expect(handles).not.toContain("ollama-cloud/gpt-oss:120b");
  });

  test("uses LM Studio env API key for discovery when stored key is placeholder", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-lmstudio-env-key-"),
    );
    await createOrUpdateLocalProvider({
      providerType: "lmstudio",
      providerName: "lc-lmstudio",
      apiKey: "not-needed",
      baseURL: "http://localhost:8000/v1",
      storageDir,
    });
    const captured: { authorization?: string | null } = {};
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String(input);
      if (url === "http://localhost:8000/v1/models") {
        captured.authorization = new Headers(init?.headers).get(
          "Authorization",
        );
        return new Response(
          JSON.stringify({ data: [{ id: "secure-model" }] }),
          {
            headers: { "content-type": "application/json" },
          },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    await withEnv({ LMSTUDIO_API_KEY: "1234" }, async () => {
      const handles = (
        await listLocalModels(storageDir, { fetch: fetchImpl })
      ).map((model) => model.handle);

      expect(handles).toContain("lmstudio/secure-model");
    });

    expect(captured.authorization).toBe("Bearer 1234");
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
      schema_version: 2,
      message_format: "pi-session-entry-jsonl",
      provider_stack: "pi-ai",
    });
    const entries = (await readFile(join(dir, "messages.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    const messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as Record<string, unknown>);
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

      if (contexts.length === 2) {
        const emptyMessage = assistantMessage({
          responseId: "response-empty-after-tool",
          stopReason: "stop",
          content: [],
        });
        return streamFromEvents(
          [{ type: "done", reason: "stop", message: emptyMessage }],
          emptyMessage,
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

    const continuationChunks = await collect(
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

    expect(
      continuationChunks.map(
        (chunk) => (chunk as { message_type?: string }).message_type,
      ),
    ).toEqual(["usage_statistics", "stop_reason"]);

    expect(contexts).toHaveLength(2);
    const secondContextMessages = contexts[1]?.messages ?? [];
    expect(secondContextMessages.at(-1)).toMatchObject({
      role: "toolResult",
      toolCallId: "call-readme",
      content: [{ type: "text", text: "README contents" }],
    });

    const conversationDir = await firstConversationDir(storageDir);
    const entries = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries[0]).toMatchObject({ type: "session", version: 3 });
    const messages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as Record<string, unknown>);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    const finalAssistant = messages.at(-1) as { content?: unknown[] };
    expect(finalAssistant.content).toEqual([]);

    const reloadedBackend = new LocalBackend({
      storageDir,
      stream,
      memfsEnabled: false,
    });
    const reloadedMessages = pageItems(
      await reloadedBackend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(reloadedMessages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
      "reasoning_message",
      "approval_request_message",
      "tool_return_message",
    ]);
  });

  test("persists updated assistant snapshots when tool calls are appended later", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-tool-update-"),
    );
    let calls = 0;
    const executor: HeadlessTurnExecutor = {
      async execute() {
        calls += 1;
        if (calls === 1) {
          return lettaStreamFromChunks([
            {
              message_type: "assistant_message",
              content: [{ type: "text", text: "I will inspect that." }],
            } as LettaStreamingResponse,
            {
              message_type: "stop_reason",
              stop_reason: "end_turn",
            } as LettaStreamingResponse,
          ]);
        }

        return lettaStreamFromChunks([
          {
            message_type: "approval_request_message",
            tool_call: {
              tool_call_id: "call-readme",
              name: "Read",
              arguments: JSON.stringify({ path: "README.md" }),
            },
          } as LettaStreamingResponse,
          {
            message_type: "stop_reason",
            stop_reason: "requires_approval",
          } as LettaStreamingResponse,
        ]);
      },
    };
    const backend = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const agent = await backend.createAgent({ name: "Local" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);

    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "inspect the readme" }],
      } as ConversationMessageCreateBody),
    );
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [],
      } as never),
    );

    const conversationDir = await firstConversationDir(storageDir);
    const entries = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const assistantMessages = entries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as Record<string, unknown>)
      .filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(2);
    expect(new Set(assistantMessages.map((message) => message.id)).size).toBe(
      1,
    );
    expect(JSON.stringify(assistantMessages.at(-1))).toContain("call-readme");

    const reloadedBackend = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const reloadedMessages = pageItems(
      await reloadedBackend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(reloadedMessages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
      "approval_request_message",
    ]);

    const conversationPath = join(conversationDir, "conversation.json");
    const persistedConversation = JSON.parse(
      await readFile(conversationPath, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      conversationPath,
      `${JSON.stringify(
        { ...persistedConversation, in_context_message_ids: [] },
        null,
        2,
      )}\n`,
    );
    const reloadedWithoutActiveIds = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const messagesWithoutActiveIds = pageItems(
      await reloadedWithoutActiveIds.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(
      messagesWithoutActiveIds.map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "assistant_message",
      "approval_request_message",
    ]);
  });

  test("repairs orphan tool results from active local transcript context", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-orphan-tool-result-"),
    );
    const executor: HeadlessTurnExecutor = {
      async execute() {
        return lettaStreamFromChunks([
          {
            message_type: "assistant_message",
            content: [{ type: "text", text: "done" }],
          } as LettaStreamingResponse,
          {
            message_type: "stop_reason",
            stop_reason: "end_turn",
          } as LettaStreamingResponse,
        ]);
      },
    };
    const backend = new LocalBackend({
      storageDir,
      executor,
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

    const conversationDir = await firstConversationDir(storageDir);
    const messagesPath = join(conversationDir, "messages.jsonl");
    const conversationPath = join(conversationDir, "conversation.json");
    const rows = (await readFile(messagesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const parentId = rows.at(-1)?.id;
    if (typeof parentId !== "string") {
      throw new Error("Expected a parent entry id");
    }
    const timestamp = new Date().toISOString();
    const orphanMessage = {
      id: "ui-msg-9999",
      role: "toolResult",
      toolCallId: "call-missing",
      toolName: "Read",
      content: [{ type: "text", text: "orphan output" }],
      isError: false,
      timestamp: Date.now(),
      metadata: {
        created_at: timestamp,
        updated_at: timestamp,
        agent_id: agent.id,
        conversation_id: conversation.id,
      },
    };
    await appendFile(
      messagesPath,
      `${JSON.stringify({
        type: "message",
        id: "orphan-entry",
        parentId,
        timestamp,
        message: orphanMessage,
      })}\n`,
    );
    const persistedConversation = JSON.parse(
      await readFile(conversationPath, "utf8"),
    ) as { in_context_message_ids?: string[] };
    await writeFile(
      conversationPath,
      `${JSON.stringify(
        {
          ...persistedConversation,
          in_context_message_ids: [
            ...(persistedConversation.in_context_message_ids ?? []),
            orphanMessage.id,
          ],
        },
        null,
        2,
      )}\n`,
    );

    const reloadedBackend = new LocalBackend({
      storageDir,
      executor,
      memfsEnabled: false,
    });
    const reloadedMessages = pageItems(
      await reloadedBackend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(
      reloadedMessages.map((message) => message.message_type),
    ).not.toContain("tool_return_message");
    const repairedConversation = JSON.parse(
      await readFile(conversationPath, "utf8"),
    ) as { in_context_message_ids?: string[] };
    expect(repairedConversation.in_context_message_ids).not.toContain(
      orphanMessage.id,
    );
    expect(await readFile(messagesPath, "utf8")).toContain(orphanMessage.id);

    await drain(
      await reloadedBackend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "next" }],
      } as ConversationMessageCreateBody),
    );
    const messagesAfterNextTurn = pageItems(
      await reloadedBackend.listConversationMessages(conversation.id, {
        agent_id: agent.id,
        order: "asc",
      } as never),
    );
    expect(messagesAfterNextTurn.map((message) => message.id)).toContain(
      "ui-msg-10000",
    );
  });

  test("clips oversized tool results when loading local transcript context", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-large-tool-result-"),
    );
    const contexts: Context[] = [];
    const stream: PiStreamFunction = (
      _model: Model<string>,
      context: Context,
    ) => {
      contexts.push(context);
      const finalMessage = assistantMessage({
        responseId: "response-done",
        stopReason: "stop",
        content: [{ type: "text", text: "done" }],
      });
      return streamFromEvents(
        [{ type: "done", reason: "stop", message: finalMessage }],
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
    await drain(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "hello" }],
      } as ConversationMessageCreateBody),
    );

    const conversationDir = await firstConversationDir(storageDir);
    const messagesPath = join(conversationDir, "messages.jsonl");
    const conversationPath = join(conversationDir, "conversation.json");
    const rows = (await readFile(messagesPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const parentId = rows.at(-1)?.id;
    if (typeof parentId !== "string") {
      throw new Error("Expected a parent entry id");
    }
    const timestamp = new Date().toISOString();
    const assistantToolMessage = {
      id: "ui-msg-9998",
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-huge",
          name: "ShellCommand",
          arguments: { command: "cat huge.log" },
        },
      ],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
      usage: emptyLocalUsage(),
      stopReason: "toolUse",
      timestamp: Date.now(),
      metadata: {
        created_at: timestamp,
        updated_at: timestamp,
        agent_id: agent.id,
        conversation_id: conversation.id,
      },
    };
    const hugeToolOutput = `${"x".repeat(
      LOCAL_REPAIRED_TOOL_RESULT_TEXT_MAX_CHARS + 20_000,
    )}TAIL`;
    const toolResultMessage = {
      id: "ui-msg-9999",
      role: "toolResult",
      toolCallId: "call-huge",
      toolName: "ShellCommand",
      content: [{ type: "text", text: hugeToolOutput }],
      isError: false,
      timestamp: Date.now(),
      metadata: {
        created_at: timestamp,
        updated_at: timestamp,
        agent_id: agent.id,
        conversation_id: conversation.id,
      },
    };
    await appendFile(
      messagesPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-tool-entry",
        parentId,
        timestamp,
        message: assistantToolMessage,
      })}\n${JSON.stringify({
        type: "message",
        id: "large-tool-result-entry",
        parentId: "assistant-tool-entry",
        timestamp,
        message: toolResultMessage,
      })}\n`,
    );
    const persistedConversation = JSON.parse(
      await readFile(conversationPath, "utf8"),
    ) as { in_context_message_ids?: string[] };
    await writeFile(
      conversationPath,
      `${JSON.stringify(
        {
          ...persistedConversation,
          in_context_message_ids: [
            ...(persistedConversation.in_context_message_ids ?? []),
            assistantToolMessage.id,
            toolResultMessage.id,
          ],
        },
        null,
        2,
      )}\n`,
    );

    const reloadedBackend = new LocalBackend({
      storageDir,
      stream,
      memfsEnabled: false,
    });
    await drain(
      await reloadedBackend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "next" }],
      } as ConversationMessageCreateBody),
    );

    const reloadedContext = contexts.at(-1);
    expect(reloadedContext).toBeDefined();
    const providerToolResult = reloadedContext?.messages.find(
      (message) => message.role === "toolResult",
    );
    if (!providerToolResult || providerToolResult.role !== "toolResult") {
      throw new Error("Expected provider tool result");
    }
    const providerText = providerToolResult.content.find(
      (content) => content.type === "text",
    )?.text;
    expect(providerText?.length).toBeLessThanOrEqual(
      LOCAL_REPAIRED_TOOL_RESULT_TEXT_MAX_CHARS,
    );
    expect(providerText).toContain(
      "Tool result truncated during local transcript repair",
    );
    expect(providerText?.endsWith("TAIL")).toBe(true);
    expect(await readFile(messagesPath, "utf8")).toContain(hugeToolOutput);

    await reloadedBackend.updateConversation(conversation.id, {
      summary: "updated summary",
    } as never);
    const persistedAfterConversationUpdate = await readFile(
      messagesPath,
      "utf8",
    );
    expect(persistedAfterConversationUpdate).toContain(hugeToolOutput);
    expect(persistedAfterConversationUpdate).not.toContain(
      "Tool result truncated during local transcript repair",
    );
  });

  test("defers unversioned transcript migration errors until transcript read", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-legacy-"),
    );
    const conversationDir = join(storageDir, "conversations", "legacy");
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", "agent-local-default.json"),
      `${JSON.stringify({
        id: "agent-local-default",
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "openai/gpt-5-mini",
        model_settings: { model: "openai/gpt-5-mini" },
      })}\n`,
    );
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

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    await expect(
      backend.listConversationMessages("local-conv-1", {
        agent_id: "agent-local-default",
        order: "asc",
      } as never),
    ).rejects.toThrow(LocalTranscriptMigrationRequiredError);
    await expect(
      backend.listConversationMessages("local-conv-1", {
        agent_id: "agent-local-default",
        order: "asc",
      } as never),
    ).rejects.toThrow(
      `letta local-backend migrate-transcripts --storage-dir "${storageDir}"`,
    );
  });

  test("defers unsupported transcript manifest errors until transcript read", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-unsupported-"),
    );
    const conversationDir = join(storageDir, "conversations", "unsupported");
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", "agent-local-default.json"),
      `${JSON.stringify({
        id: "agent-local-default",
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "openai/gpt-5-mini",
        model_settings: { model: "openai/gpt-5-mini" },
      })}\n`,
    );
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
      join(conversationDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 999,
        message_format: "future-jsonl",
        provider_stack: "pi-ai",
        created_at: new Date().toISOString(),
      })}\n`,
    );
    await writeFile(join(conversationDir, "messages.jsonl"), "");

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    await expect(
      backend.listConversationMessages("local-conv-1", {
        agent_id: "agent-local-default",
        order: "asc",
      } as never),
    ).rejects.toThrow("Unsupported local transcript format");
  });

  test("skips malformed conversation metadata during explicit listing", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-bad-conversation-"),
    );
    const conversationDir = join(storageDir, "conversations", "bad");
    await mkdir(conversationDir, { recursive: true });
    await writeFile(join(conversationDir, "conversation.json"), "{bad json");
    await writeFile(
      join(conversationDir, "manifest.json"),
      `${JSON.stringify({
        schema_version: 999,
        message_format: "future-jsonl",
        provider_stack: "pi-ai",
        created_at: new Date().toISOString(),
      })}\n`,
    );

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    expect(((await backend.listConversations()) as unknown[]).length).toBe(0);
  });

  test("refuses to read versioned transcripts with legacy UI rows and repairs them with migrate-transcripts", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-pi-repair-"),
    );
    const conversationDir = join(storageDir, "conversations", "mismatched");
    await mkdir(join(storageDir, "agents"), { recursive: true });
    await writeFile(
      join(storageDir, "agents", "agent-local-default.json"),
      `${JSON.stringify({
        id: "agent-local-default",
        name: "Local",
        description: null,
        system: "",
        tags: [],
        model: "openai/gpt-5-mini",
        model_settings: { model: "openai/gpt-5-mini" },
      })}\n`,
    );
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

    const backend = new LocalBackend({ storageDir, memfsEnabled: false });
    await expect(
      backend.listConversationMessages("local-conv-1", {
        agent_id: "agent-local-default",
        order: "asc",
      } as never),
    ).rejects.toThrow(LocalTranscriptRepairRequiredError);
    await expect(
      backend.listConversationMessages("local-conv-1", {
        agent_id: "agent-local-default",
        order: "asc",
      } as never),
    ).rejects.toThrow(
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
    expect(manifest.schema_version).toBe(2);
    expect(manifest.message_format).toBe("pi-session-entry-jsonl");
    const convertedEntries = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(convertedEntries[0]).toMatchObject({ type: "session" });
    const converted = convertedEntries.find((entry) => entry.type === "message")
      ?.message as Record<string, unknown>;
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
    expect(manifest.schema_version).toBe(2);
    expect(manifest.message_format).toBe("pi-session-entry-jsonl");
    const convertedEntries = (
      await readFile(join(conversationDir, "messages.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(convertedEntries[0]).toMatchObject({ type: "session" });
    const converted = convertedEntries
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as { role: string });
    expect(converted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(JSON.stringify(converted)).toContain('"thinking"');
    expect(JSON.stringify(converted)).toContain('"toolCall"');
  });
});
