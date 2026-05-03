import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { validateUIMessages } from "ai";
import type {
  AgentCreateBody,
  AgentMessageListBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  ConversationMessageStreamBody,
  RunMessageStreamBody,
} from "../../backend";
import { FakeHeadlessBackend } from "../../backend/dev/FakeHeadlessBackend";
import {
  DeterministicToolCallExecutor,
  type HeadlessTurnExecutor,
} from "../../backend/dev/HeadlessTurnExecutor";

async function collectStream(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function drainAssistantText(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    if (chunk.message_type !== "assistant_message") continue;
    const content = chunk.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        "type" in part &&
        part.type === "text" &&
        "text" in part &&
        typeof part.text === "string"
      ) {
        text += part.text;
      }
    }
  }
  return text;
}

function createBody(
  text: string,
  agentId: string,
): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [],
    client_skills: [],
    agent_id: agentId,
  } as unknown as ConversationMessageCreateBody;
}

function jsonl(text: string): unknown[] {
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function conversationDir(storageDir: string, conversationId: string): string {
  return join(
    storageDir,
    "conversations",
    Buffer.from(`conversation:${conversationId}`).toString("base64url"),
  );
}

describe("FakeHeadlessBackend", () => {
  test("creates agents and lists local models through the backend facade", async () => {
    const backend = new FakeHeadlessBackend("agent-default");
    expect(backend.capabilities.remoteMemfs).toBe(false);

    const agent = await backend.createAgent({
      name: "Created Agent",
      system: "system prompt",
      model: "dev/fake-headless",
      tools: ["web_search"],
      tags: ["origin:test"],
    } as AgentCreateBody);
    const retrieved = await backend.retrieveAgent(agent.id);
    const models = await backend.listModels();

    expect(agent.id).toStartWith("agent-local-");
    expect(retrieved.name).toBe("Created Agent");
    expect(retrieved.system).toBe("system prompt");
    expect(retrieved.tools?.map((tool) => tool.name)).toEqual([]);
    expect(retrieved.tags).toEqual(["origin:test"]);
    expect(retrieved.model).toBe("dev/fake-headless");
    expect(retrieved.model_settings).toEqual({});
    expect(models.map((model) => model.handle)).toEqual(["dev/fake-headless"]);
  });

  test("persists a minimal local agent record", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-store-"));
    try {
      const backend = new FakeHeadlessBackend("agent-default", undefined, {
        storageDir,
      });
      const agent = await backend.createAgent({
        name: "Minimal Agent",
        description: "stored small",
        system: "system prompt",
        model: "dev/fake-headless",
        tools: ["web_search"],
        tags: ["origin:test"],
        memory_blocks: [{ label: "human", value: "ignore me" }],
        block_ids: ["block-ignore"],
        include_base_tools: false,
        include_base_tool_rules: false,
        initial_message_sequence: [],
        compaction_settings: { mode: "server-only" },
        parallel_tool_calls: true,
        context_window_limit: 128000,
      } as unknown as AgentCreateBody);

      const files = await readdir(join(storageDir, "agents"));
      const storedAgentFile = files.find((file) =>
        file.includes(Buffer.from(agent.id).toString("base64url")),
      );
      expect(storedAgentFile).toBeDefined();
      const persisted = JSON.parse(
        await readFile(
          join(storageDir, "agents", storedAgentFile ?? ""),
          "utf8",
        ),
      ) as Record<string, unknown>;

      expect(Object.keys(persisted).sort()).toEqual([
        "description",
        "id",
        "model",
        "model_settings",
        "name",
        "system",
        "tags",
      ]);
      expect(persisted).toMatchObject({
        id: agent.id,
        name: "Minimal Agent",
        description: "stored small",
        system: "system prompt",
        tags: ["origin:test"],
        model: "dev/fake-headless",
        model_settings: {
          context_window_limit: 128000,
          parallel_tool_calls: true,
        },
      });
      expect(persisted.tools).toBeUndefined();
      expect(persisted.memory_blocks).toBeUndefined();
      expect(persisted.block_ids).toBeUndefined();
      expect(persisted.llm_config).toBeUndefined();
      expect(persisted.message_ids).toBeUndefined();
      expect(persisted.in_context_message_ids).toBeUndefined();
      expect(persisted.compaction_settings).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("strict agent retrieval returns created agents and rejects missing agents", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-strict-"));
    try {
      const backend = new FakeHeadlessBackend("agent-default", undefined, {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
      });

      await expect(backend.retrieveAgent("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found",
      );

      let files: string[] = [];
      try {
        files = await readdir(join(storageDir, "agents"));
      } catch {
        files = [];
      }
      expect(files).toEqual([]);

      const agent = await backend.createAgent({
        name: "Created Agent",
        model: "dev/fake-headless",
      } as AgentCreateBody);
      await expect(backend.retrieveAgent(agent.id)).resolves.toMatchObject({
        id: agent.id,
        name: "Created Agent",
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("strict agent updates require existing agents and keep persistence minimal", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-update-"));
    try {
      const backend = new FakeHeadlessBackend("agent-default", undefined, {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
      });

      await expect(
        backend.updateAgent("agent-missing", { name: "Nope" }),
      ).rejects.toThrow("Agent agent-missing not found");

      let files: string[] = [];
      try {
        files = await readdir(join(storageDir, "agents"));
      } catch {
        files = [];
      }
      expect(files).toEqual([]);

      const agent = await backend.createAgent({
        name: "Before",
        description: "old",
        system: "old system",
        model: "dev/fake-headless",
        tags: ["origin:test"],
        parallel_tool_calls: false,
      } as AgentCreateBody);

      const updated = await backend.updateAgent(agent.id, {
        name: "After",
        description: null,
        system: "new system",
        tags: ["origin:test", "updated"],
        model: "dev/updated",
        model_settings: { provider_type: "openai", strict: true },
        context_window_limit: 64000,
        max_tokens: 2048,
        tools: ["web_search"],
        memory_blocks: [{ label: "ignore", value: "ignore" }],
        block_ids: ["block-ignore"],
        compaction_settings: { mode: "server-only" },
      } as unknown as Parameters<typeof backend.updateAgent>[1]);

      expect(updated).toMatchObject({
        id: agent.id,
        name: "After",
        description: null,
        system: "new system",
        tags: ["origin:test", "updated"],
        model: "dev/updated",
        tools: [],
        model_settings: {
          provider_type: "openai",
          strict: true,
          context_window_limit: 64000,
          max_tokens: 2048,
        },
      });

      const agentFiles = await readdir(join(storageDir, "agents"));
      expect(agentFiles).toHaveLength(1);
      const persisted = JSON.parse(
        await readFile(join(storageDir, "agents", agentFiles[0] ?? ""), "utf8"),
      ) as Record<string, unknown>;

      expect(Object.keys(persisted).sort()).toEqual([
        "description",
        "id",
        "model",
        "model_settings",
        "name",
        "system",
        "tags",
      ]);
      expect(persisted).toMatchObject({
        id: agent.id,
        name: "After",
        description: null,
        system: "new system",
        tags: ["origin:test", "updated"],
        model: "dev/updated",
      });
      expect(persisted.tools).toBeUndefined();
      expect(persisted.memory_blocks).toBeUndefined();
      expect(persisted.block_ids).toBeUndefined();
      expect(persisted.llm_config).toBeUndefined();
      expect(persisted.compaction_settings).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("strict conversation lifecycle routes require existing records and persist supported fields", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-conv-"));
    try {
      const backend = new FakeHeadlessBackend("agent-default", undefined, {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
        strictConversationAccess: true,
      });

      await expect(
        backend.retrieveConversation("conv-missing"),
      ).rejects.toThrow("Conversation conv-missing not found");
      await expect(
        backend.createConversation({ agent_id: "agent-missing" }),
      ).rejects.toThrow("Agent agent-missing not found");

      let conversationFiles: string[] = [];
      try {
        conversationFiles = await readdir(join(storageDir, "conversations"));
      } catch {
        conversationFiles = [];
      }
      expect(conversationFiles).toEqual([]);

      const agent = await backend.createAgent({
        name: "Conversation Agent",
        model: "dev/fake-headless",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        summary: "initial summary",
        model: "anthropic/claude-test",
        model_settings: { provider_type: "anthropic", strict: true },
        isolated_block_labels: ["ignore"],
      } as ConversationCreateBody);

      expect(conversation).toMatchObject({
        agent_id: agent.id,
        archived: false,
        archived_at: null,
        summary: "initial summary",
        model: "anthropic/claude-test",
        model_settings: { provider_type: "anthropic", strict: true },
        in_context_message_ids: [],
      });
      expect(
        (conversation as unknown as Record<string, unknown>)
          .isolated_block_labels,
      ).toBeUndefined();
      expect(await backend.retrieveConversation(conversation.id)).toMatchObject(
        {
          id: conversation.id,
          agent_id: agent.id,
        },
      );

      const updated = await backend.updateConversation(conversation.id, {
        archived: true,
        summary: null,
        model: "openai/gpt-test",
        model_settings: { provider_type: "openai", max_tokens: 1000 },
        last_message_at: "2026-01-02T00:00:00.000Z",
        ignored: "nope",
      } as unknown as Parameters<typeof backend.updateConversation>[1]);
      expect(updated).toMatchObject({
        id: conversation.id,
        archived: true,
        summary: null,
        model: "openai/gpt-test",
        model_settings: { provider_type: "openai", max_tokens: 1000 },
        last_message_at: "2026-01-02T00:00:00.000Z",
      });
      expect(typeof updated.archived_at).toBe("string");

      const persisted = JSON.parse(
        await readFile(
          join(
            conversationDir(storageDir, conversation.id),
            "conversation.json",
          ),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(persisted.ignored).toBeUndefined();
      expect(persisted.isolated_block_labels).toBeUndefined();
      expect(persisted.forked_from).toBeUndefined();
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("stores user and assistant messages for explicit conversations", async () => {
    const backend = new FakeHeadlessBackend("agent-test");
    const conversation = await backend.createConversation({
      agent_id: "agent-test",
    });

    const stream = await backend.createConversationMessageStream(
      conversation.id,
      createBody("hello", "agent-test"),
    );
    await expect(drainAssistantText(stream)).resolves.toBe("pong");

    const page = await backend.listConversationMessages(conversation.id, {
      order: "asc",
    } as ConversationMessageListBody);
    const messages = page.getPaginatedItems();

    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(JSON.stringify(messages[0])).toContain("hello");
    expect(JSON.stringify(messages[1])).toContain("pong");

    const updatedConversation = (await backend.retrieveConversation(
      conversation.id,
    )) as { in_context_message_ids?: string[] };
    expect(updatedConversation.in_context_message_ids).toHaveLength(2);
  });

  test("send-turn routes attach local run metadata and persist projected output", async () => {
    const backend = new FakeHeadlessBackend("agent-run");
    const conversation = await backend.createConversation({
      agent_id: "agent-run",
    } as ConversationCreateBody);

    const chunks = await collectStream(
      await backend.streamConversationMessages(
        conversation.id,
        createBody(
          "run metadata",
          "agent-run",
        ) as unknown as ConversationMessageStreamBody,
      ),
    );
    const runIds = new Set(
      chunks
        .map((chunk) => (chunk as { run_id?: unknown }).run_id)
        .filter((runId): runId is string => typeof runId === "string"),
    );
    expect(runIds.size).toBe(1);
    const runId = [...runIds][0] ?? "";
    const run = await backend.retrieveRun(runId);
    expect(run).toMatchObject({
      id: runId,
      agent_id: "agent-run",
      conversation_id: conversation.id,
      status: "completed",
      stop_reason: "end_turn",
      background: true,
      metadata: { backend: "fake-headless" },
    });

    expect(chunks.at(-1)).toMatchObject({
      message_type: "stop_reason",
      stop_reason: "end_turn",
      run_id: runId,
    });

    const replayed = await collectStream(
      await backend.streamRunMessages(runId, {} as RunMessageStreamBody),
    );
    expect(replayed.map((chunk) => chunk.message_type)).toEqual(
      chunks.map((chunk) => chunk.message_type),
    );
    expect(
      replayed.every(
        (chunk) => (chunk as { run_id?: unknown }).run_id === runId,
      ),
    ).toBe(true);
    expect((replayed[0] as unknown as { seq_id?: number }).seq_id).toBe(1);

    const replayedAfterFirst = await collectStream(
      await backend.streamRunMessages(runId, {
        starting_after: 1,
      } as RunMessageStreamBody),
    );
    expect(
      replayedAfterFirst.map(
        (chunk) => (chunk as unknown as { seq_id?: number }).seq_id,
      ),
    ).toEqual([2]);
  });

  test("run routes reject missing local runs", async () => {
    const backend = new FakeHeadlessBackend("agent-run");
    await expect(backend.retrieveRun("run-missing")).rejects.toThrow(
      "Run run-missing not found",
    );
    await expect(
      backend.streamRunMessages("run-missing", {} as RunMessageStreamBody),
    ).rejects.toThrow("Run run-missing not found");
  });

  test("cancelConversation marks an active local run cancelled", async () => {
    let controller: AbortController | undefined;
    const executor: HeadlessTurnExecutor = {
      async execute() {
        controller = new AbortController();
        return {
          controller,
          async *[Symbol.asyncIterator]() {
            yield {
              message_type: "assistant_message",
              content: [{ type: "text", text: "should not matter" }],
            } as LettaStreamingResponse;
          },
        } as unknown as Awaited<ReturnType<HeadlessTurnExecutor["execute"]>>;
      },
    };
    const backend = new FakeHeadlessBackend("agent-cancel", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-cancel",
    } as ConversationCreateBody);

    await backend.createConversationMessageStream(
      conversation.id,
      createBody("cancel me", "agent-cancel"),
    );
    const cancelResult = (await backend.cancelConversation(
      conversation.id,
    )) as unknown as { status: string };
    expect(cancelResult).toEqual({ status: "cancelled" });
    expect(controller?.signal.aborted).toBe(true);

    await expect(
      backend.retrieveRun("run-fake-headless-1"),
    ).resolves.toMatchObject({
      id: "run-fake-headless-1",
      status: "cancelled",
      stop_reason: "cancelled",
    });
    const replayed = await collectStream(
      await backend.streamRunMessages(
        "run-fake-headless-1",
        {} as RunMessageStreamBody,
      ),
    );
    expect(replayed).toMatchObject([
      {
        message_type: "stop_reason",
        stop_reason: "cancelled",
        run_id: "run-fake-headless-1",
        seq_id: 1,
      },
    ]);
  });

  test("strict send-turn routes reject before appending local messages", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-turn-"));
    try {
      const backend = new FakeHeadlessBackend("agent-default", undefined, {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
        strictConversationAccess: true,
      });

      await expect(
        backend.createConversationMessageStream(
          "conv-missing",
          createBody("should not persist", "agent-missing"),
        ),
      ).rejects.toThrow("Agent agent-missing not found");

      const agent = await backend.createAgent({
        name: "Turn Agent",
        model: "dev/fake-headless",
      } as AgentCreateBody);
      await expect(
        backend.streamConversationMessages(
          "conv-missing",
          createBody(
            "should not persist either",
            agent.id,
          ) as unknown as ConversationMessageStreamBody,
        ),
      ).rejects.toThrow("Conversation conv-missing not found");

      const missingConversationPath = conversationDir(
        storageDir,
        "conv-missing",
      );
      await expect(readdir(missingConversationPath)).rejects.toThrow();
      const conversationDirs = await readdir(join(storageDir, "conversations"));
      for (const conversationDirName of conversationDirs) {
        const messagesPath = join(
          storageDir,
          "conversations",
          conversationDirName,
          "messages.jsonl",
        );
        const messages = jsonl(await readFile(messagesPath, "utf8"));
        expect(messages).toEqual([]);
      }
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("strict message routes require existing records and retrieve projected messages", async () => {
    const backend = new FakeHeadlessBackend("agent-default", undefined, {
      seedDefaultAgent: false,
      strictAgentAccess: true,
      strictConversationAccess: true,
    });

    await expect(
      backend.listAgentMessages("agent-missing", {
        conversation_id: "default",
      } as AgentMessageListBody),
    ).rejects.toThrow("Agent agent-missing not found");

    const agent = await backend.createAgent({
      name: "Message Agent",
      model: "dev/fake-headless",
    } as AgentCreateBody);
    await expect(
      backend.listConversationMessages("conv-missing", {
        agent_id: agent.id,
      } as ConversationMessageListBody),
    ).rejects.toThrow("Conversation conv-missing not found");
    await expect(backend.retrieveMessage("msg-missing")).rejects.toThrow(
      "Message msg-missing not found",
    );

    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as ConversationCreateBody);
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("retrieve me", agent.id),
      ),
    );

    const page = await backend.listConversationMessages(conversation.id, {
      order: "asc",
    } as ConversationMessageListBody);
    const messages = page.getPaginatedItems();
    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);

    const retrieved = await backend.retrieveMessage(messages[0]?.id ?? "");
    expect(retrieved).toHaveLength(1);
    expect(retrieved[0]?.id).toBe(messages[0]?.id);
    expect(JSON.stringify(retrieved[0])).toContain("retrieve me");
  });

  test("persists AI SDK UIMessage JSONL as the canonical transcript", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-ui-"));
    try {
      const backend = new FakeHeadlessBackend("agent-ui", undefined, {
        storageDir,
      });
      const conversation = await backend.createConversation({
        agent_id: "agent-ui",
      });

      await drainAssistantText(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("hello ui", "agent-ui"),
        ),
      );

      const conversationDirs = await readdir(join(storageDir, "conversations"));
      expect(conversationDirs).toHaveLength(2);
      const conversationDir = join(
        storageDir,
        "conversations",
        Buffer.from(`conversation:${conversation.id}`).toString("base64url"),
      );
      const files = await readdir(conversationDir);
      expect(files.sort()).toEqual(["conversation.json", "messages.jsonl"]);

      const persistedMessages = jsonl(
        await readFile(join(conversationDir, "messages.jsonl"), "utf8"),
      );
      await expect(
        validateUIMessages({ messages: persistedMessages }),
      ).resolves.toHaveLength(2);
      expect(
        persistedMessages.map(
          (message) => (message as { role?: unknown }).role,
        ),
      ).toEqual(["user", "assistant"]);
      for (const message of persistedMessages) {
        const record = message as Record<string, unknown>;
        expect(typeof record.id).toBe("string");
        expect(Array.isArray(record.parts)).toBe(true);
        expect(record.message_type).toBeUndefined();
        expect(record.date).toBeUndefined();
        expect(record.agent_id).toBeUndefined();
        expect(record.conversation_id).toBeUndefined();
        expect(record.metadata).toMatchObject({
          agent_id: "agent-ui",
          conversation_id: conversation.id,
        });
      }

      const page = await backend.listConversationMessages(conversation.id, {
        order: "asc",
      } as ConversationMessageListBody);
      expect(
        page.getPaginatedItems().map((message) => message.message_type),
      ).toEqual(["user_message", "assistant_message"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("supports default conversation listing through agent messages", async () => {
    const backend = new FakeHeadlessBackend("agent-default");

    await drainAssistantText(
      await backend.createConversationMessageStream(
        "default",
        createBody("default hello", "agent-default"),
      ),
    );

    const page = await backend.listAgentMessages("agent-default", {
      conversation_id: "default",
      order: "asc",
    } as AgentMessageListBody);
    const messages = page.getPaginatedItems();

    expect(messages).toHaveLength(2);
    expect(messages.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(JSON.stringify(messages)).toContain("default hello");
  });

  test("appends repeated turns and paginates newest-first history", async () => {
    const backend = new FakeHeadlessBackend("agent-pages");
    const conversation = await backend.createConversation({
      agent_id: "agent-pages",
    });

    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("first", "agent-pages"),
      ),
    );
    await drainAssistantText(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("second", "agent-pages"),
      ),
    );

    const firstPage = await backend.listConversationMessages(conversation.id, {
      order: "desc",
      limit: 2,
    } as ConversationMessageListBody);
    const firstPageItems = firstPage.getPaginatedItems();

    expect(firstPageItems.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(firstPageItems)).toContain("second");

    const secondPage = await backend.listConversationMessages(conversation.id, {
      order: "desc",
      limit: 2,
      before: firstPageItems.at(-1)?.id,
    } as ConversationMessageListBody);
    const secondPageItems = secondPage.getPaginatedItems();

    expect(secondPageItems.map((message) => message.message_type)).toEqual([
      "assistant_message",
      "user_message",
    ]);
    expect(JSON.stringify(secondPageItems)).toContain("first");
  });

  test("persists deterministic tool request and approval-result output", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-tool",
      new DeterministicToolCallExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-tool",
    });

    const firstChunks = await collectStream(
      await backend.createConversationMessageStream(
        conversation.id,
        createBody("use a tool", "agent-tool"),
      ),
    );
    const approvalChunk = firstChunks.find(
      (chunk) => chunk.message_type === "approval_request_message",
    ) as
      | (LettaStreamingResponse & {
          tool_call?: { tool_call_id?: string; name?: string };
        })
      | undefined;
    expect(approvalChunk?.tool_call?.name).toBe("Bash");
    expect(
      firstChunks.some(
        (chunk) =>
          chunk.message_type === "stop_reason" &&
          chunk.stop_reason === "requires_approval",
      ),
    ).toBe(true);

    const afterRequest = await backend.listConversationMessages(
      conversation.id,
      { order: "asc" } as ConversationMessageListBody,
    );
    expect(
      afterRequest.getPaginatedItems().map((message) => message.message_type),
    ).toEqual(["user_message", "approval_request_message"]);

    const finalText = await drainAssistantText(
      await backend.createConversationMessageStream(conversation.id, {
        ...createBody("", "agent-tool"),
        messages: [
          {
            type: "approval",
            approvals: [
              {
                type: "tool",
                tool_call_id: approvalChunk?.tool_call?.tool_call_id,
                tool_return: "deterministic-tool-ok",
                status: "success",
              },
            ],
          },
        ],
      } as unknown as ConversationMessageCreateBody),
    );
    expect(finalText).toContain("tool result received (success)");
    expect(finalText).toContain("deterministic-tool-ok");

    const afterApproval = await backend.listConversationMessages(
      conversation.id,
      { order: "asc" } as ConversationMessageListBody,
    );
    expect(
      afterApproval.getPaginatedItems().map((message) => message.message_type),
    ).toEqual([
      "user_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]);
  });

  test("forks conversations by copying LocalMessage transcript state", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-fork-"));
    try {
      const backend = new FakeHeadlessBackend("agent-fork", undefined, {
        storageDir,
      });
      const conversation = await backend.createConversation({
        agent_id: "agent-fork",
        summary: "fork source",
      } as ConversationCreateBody);
      await drainAssistantText(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("fork me", "agent-fork"),
        ),
      );

      const forked = await backend.forkConversation(conversation.id);
      expect(forked.id).not.toBe(conversation.id);

      const sourcePage = await backend.listConversationMessages(
        conversation.id,
        {
          order: "asc",
        } as ConversationMessageListBody,
      );
      const forkedPage = await backend.listConversationMessages(forked.id, {
        order: "asc",
      } as ConversationMessageListBody);
      expect(
        forkedPage.getPaginatedItems().map((message) => message.message_type),
      ).toEqual(["user_message", "assistant_message"]);
      expect(JSON.stringify(forkedPage.getPaginatedItems())).toContain(
        "fork me",
      );
      expect(forkedPage.getPaginatedItems()[0]?.id).not.toBe(
        sourcePage.getPaginatedItems()[0]?.id,
      );

      const forkedConversation = JSON.parse(
        await readFile(
          join(conversationDir(storageDir, forked.id), "conversation.json"),
          "utf8",
        ),
      ) as Record<string, unknown>;
      expect(forkedConversation.forked_from).toBeUndefined();
      expect(forkedConversation.summary).toBe("fork source");

      const forkedMessages = jsonl(
        await readFile(
          join(conversationDir(storageDir, forked.id), "messages.jsonl"),
          "utf8",
        ),
      );
      expect(forkedMessages).toHaveLength(2);
      expect(
        forkedMessages.every(
          (message) =>
            (message as { metadata?: { conversation_id?: string } }).metadata
              ?.conversation_id === forked.id,
        ),
      ).toBe(true);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("forks the requested agent's default conversation", async () => {
    const backend = new FakeHeadlessBackend("agent-default-source");
    const otherAgent = await backend.createAgent({
      name: "Other Agent",
    } as AgentCreateBody);

    await drainAssistantText(
      await backend.createConversationMessageStream(
        "default",
        createBody("fork other default", otherAgent.id),
      ),
    );

    const forked = await backend.forkConversation("default", {
      agentId: otherAgent.id,
    });
    const forkedPage = await backend.listConversationMessages(forked.id, {
      order: "asc",
    } as ConversationMessageListBody);

    expect(JSON.stringify(forkedPage.getPaginatedItems())).toContain(
      "fork other default",
    );
  });
});
