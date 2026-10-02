import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationUpdateBody,
} from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  DeterministicToolCallExecutor,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
  providerLettaChunk,
} from "@/backend/dev/provider-turn-executor";
import { TURN_DID_NOT_COMPLETE } from "@/constants";
import { LOCAL_IN_PROCESS_STREAM } from "@/utils/stream-transport";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

class RecordingProviderAdapter implements ProviderStreamAdapter {
  input: ProviderTurnInput | undefined;

  async *stream(input: ProviderTurnInput) {
    this.input = input;
    yield providerLettaChunk({
      message_type: "stop_reason",
      stop_reason: "end_turn",
    } as never);
  }
}

class PendingSetupExecutor implements HeadlessTurnExecutor {
  input: HeadlessTurnExecutorInput | undefined;

  async execute(input: HeadlessTurnExecutorInput) {
    this.input = input;
    return await new Promise<never>((_resolve, reject) => {
      input.signal.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    });
  }
}

class LateChunkExecutor implements HeadlessTurnExecutor {
  signal: AbortSignal | undefined;
  private release!: () => void;
  readonly ready = new Promise<void>((resolve) => {
    this.release = resolve;
  });

  async execute(input: HeadlessTurnExecutorInput) {
    this.signal = input.signal;
    const source = this;
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        await source.ready;
        yield {
          message_type: "assistant_message",
          content: [{ type: "text", text: "late output" }],
        } as never;
        yield {
          message_type: "stop_reason",
          stop_reason: "end_turn",
        } as never;
      },
    } as never;
  }

  continue(): void {
    this.release();
  }
}

class AbortAwareProviderAdapter implements ProviderStreamAdapter {
  async *stream(input: Parameters<ProviderStreamAdapter["stream"]>[0]) {
    if (!input.signal) throw new Error("Expected provider signal");
    await new Promise<void>((_resolve, reject) => {
      input.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    });
  }
}

describe("FakeHeadlessBackend", () => {
  test("does not start a run for an already-aborted request", async () => {
    const executor = new PendingSetupExecutor();
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(
      backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: "agent-fake-headless",
          messages: [{ role: "user", content: "never start" }],
        } as ConversationMessageCreateBody,
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(executor.input).toBeUndefined();
    const messages = await backend.listConversationMessages(conversation.id, {
      agent_id: "agent-fake-headless",
    } as never);
    expect(messages.getPaginatedItems()).toEqual([]);
  });

  test("request cancellation stops provider setup before a stream is returned", async () => {
    const executor = new PendingSetupExecutor();
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const controller = new AbortController();
    const pending = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "wait" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );

    await Promise.resolve();
    controller.abort(new DOMException("cancelled", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(await backend.retrieveRun("run-fake-headless-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("cancels provider setup before the executor returns a stream", async () => {
    const executor = new PendingSetupExecutor();
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const pending = backend.createConversationMessageStream(conversation.id, {
      agent_id: "agent-fake-headless",
      messages: [{ role: "user", content: "wait" }],
    } as ConversationMessageCreateBody);

    await Promise.resolve();
    expect(executor.input?.signal.aborted).toBe(false);
    await backend.cancelRun("agent-fake-headless", "run-fake-headless-1");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(executor.input?.signal.aborted).toBe(true);
    expect(await backend.retrieveRun("run-fake-headless-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("direct stream abort fences late output from a non-cooperative executor", async () => {
    const executor = new LateChunkExecutor();
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "wait" }],
      } as ConversationMessageCreateBody,
    );
    const collecting = collect(stream);

    expect(
      (stream as unknown as { [LOCAL_IN_PROCESS_STREAM]?: boolean })[
        LOCAL_IN_PROCESS_STREAM
      ],
    ).toBe(true);

    stream.controller.abort(new DOMException("cancelled", "AbortError"));
    executor.continue();

    expect(await collecting).toEqual([]);
    expect(await backend.retrieveRun("run-fake-headless-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
    const replay = await collect(
      await backend.streamRunMessages("run-fake-headless-1", {} as never),
    );
    expect(JSON.stringify(replay)).not.toContain("late output");
  });

  test("direct stream abort remains cancelled when the provider cooperates", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new ProviderTurnExecutor(new AbortAwareProviderAdapter()),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "wait" }],
      } as ConversationMessageCreateBody,
    );
    const collecting = collect(stream);

    stream.controller.abort(new DOMException("cancelled", "AbortError"));

    expect(await collecting).toEqual([]);
    expect(await backend.retrieveRun("run-fake-headless-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
  });

  test("cancellation survives interrupted-tool persistence failure", async () => {
    const executor = new LateChunkExecutor();
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "wait" }],
      } as ConversationMessageCreateBody,
    );
    const store = (
      backend as unknown as {
        store: { settleInterruptedToolCalls: () => never };
      }
    ).store;
    store.settleInterruptedToolCalls = () => {
      throw new Error("injected cleanup persistence failure");
    };
    const collecting = collect(stream);

    stream.controller.abort(new DOMException("cancelled", "AbortError"));
    executor.continue();

    expect(await collecting).toEqual([]);
    expect(executor.signal?.aborted).toBe(true);
    expect(await backend.retrieveRun("run-fake-headless-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });
    const replay = (await collect(
      await backend.streamRunMessages("run-fake-headless-1", {} as never),
    )) as Array<{ message_type?: string; stop_reason?: string }>;
    expect(
      replay.filter(
        (chunk) =>
          chunk.message_type === "stop_reason" &&
          chunk.stop_reason === "cancelled",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(replay)).not.toContain("late output");
  });

  test("streams deterministic assistant responses", async () => {
    const backend = new FakeHeadlessBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "ping" }],
      } as ConversationMessageCreateBody),
    );

    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["assistant_message", "stop_reason"]);
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("persists pi-style local transcripts when storage is enabled", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "fake-headless-pi-"));
    const backend = new FakeHeadlessBackend("agent-fake-headless", undefined, {
      storageDir,
      strictAgentAccess: false,
      strictConversationAccess: false,
    });
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "persist" }],
      } as ConversationMessageCreateBody),
    );

    const conversationsDir = join(storageDir, "conversations");
    const dirs = await readdir(conversationsDir);
    let conversationDir: string | undefined;
    for (const dir of dirs) {
      const candidateDir = join(conversationsDir, dir);
      const candidate = JSON.parse(
        await readFile(join(candidateDir, "conversation.json"), "utf8"),
      ) as { id?: unknown };
      if (candidate.id === conversation.id) {
        conversationDir = candidateDir;
        break;
      }
    }
    if (!conversationDir)
      throw new Error("Expected the persisted test conversation directory");
    const manifest = JSON.parse(
      await readFile(join(conversationDir, "manifest.json"), "utf8"),
    );
    expect(manifest.provider_stack).toBe("pi-ai");
    const jsonl = await readFile(
      join(conversationDir, "messages.jsonl"),
      "utf8",
    );
    expect(jsonl).toContain('"content"');
    expect(jsonl).not.toContain('"parts"');
  });

  test("passes conversation model settings to local provider turns", async () => {
    const adapter = new RecordingProviderAdapter();
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new ProviderTurnExecutor(adapter),
      {
        strictAgentAccess: false,
        strictConversationAccess: false,
      },
    );
    const agent = await backend.createAgent({
      name: "Conversation Override Agent",
      model: "openai/gpt-5",
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "minimal" },
        parallel_tool_calls: true,
      },
    } as AgentCreateBody);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as ConversationCreateBody);
    await backend.updateConversation(conversation.id, {
      model: "openai/gpt-5.5",
      model_settings: {
        provider_type: "openai",
        reasoning: { reasoning_effort: "medium" },
      },
      context_window_limit: 500000,
    } as ConversationUpdateBody);

    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "use the override" }],
      } as ConversationMessageCreateBody),
    );

    expect(adapter.input?.agent.model).toBe("openai/gpt-5.5");
    expect(adapter.input?.agent.model_settings).toMatchObject({
      provider_type: "openai",
      reasoning: { reasoning_effort: "medium" },
      parallel_tool_calls: true,
      context_window_limit: 500000,
    });

    const storedAgent = await backend.retrieveAgent(agent.id);
    expect(storedAgent.model).toBe("openai/gpt-5");
    expect(storedAgent.model_settings).toMatchObject({
      reasoning: { reasoning_effort: "minimal" },
    });
  });

  test("settles orphaned tool calls from an interrupted turn before the next turn", async () => {
    // Simulate what happens when a turn is interrupted (crash / unhandled error)
    // before cancelConversation is called: a tool_use block is stored in the
    // conversation history but its tool_result never arrives. The next turn must
    // add a synthetic error result so the provider doesn't reject the context.
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
      { strictAgentAccess: false, strictConversationAccess: false },
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    // Run a turn that ends with a tool call (requires_approval), then do NOT
    // send a tool result — leave the tool call orphaned.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );

    // Inspect the raw local messages before the next turn: there should be one
    // tool call with no corresponding result.
    const storeBefore = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesBefore = storeBefore as Array<{
      role: string;
      content?: Array<{ type: string; id?: string }>;
      toolCallId?: string;
    }>;
    const orphanedCallIds = messagesBefore
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.content ?? [])
      .filter((c) => c.type === "toolCall")
      .map((c) => c.id ?? "");
    const existingResultIds = messagesBefore
      .filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId ?? "");
    const unsettled = orphanedCallIds.filter(
      (id) => !existingResultIds.includes(id),
    );
    expect(unsettled.length).toBe(1); // one orphaned tool call before the next turn

    // Start the next turn — executeConversationTurn should settle the orphan first.
    await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "second turn" }],
      } as ConversationMessageCreateBody),
    );

    // Now the orphaned tool call should have a synthetic error result.
    const storeAfter = (
      backend as unknown as {
        store: { listLocalMessages: (id: string) => unknown[] };
      }
    ).store.listLocalMessages(conversation.id);
    const messagesAfter = storeAfter as Array<{
      role: string;
      content?: Array<{ type: string; text?: string }>;
      toolCallId?: string;
    }>;
    const settledResult = messagesAfter.find(
      (m) =>
        m.role === "toolResult" &&
        unsettled.includes(m.toolCallId ?? "") &&
        m.content?.some((c) => c.text === TURN_DID_NOT_COMPLETE),
    );
    expect(settledResult).toBeDefined();
  });

  test("keeps approval turns open when a tool call is emitted", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new DeterministicToolCallExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "use a tool" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["approval_request_message", "stop_reason"]);
    expect(
      (chunks.at(-1) as { stop_reason?: string } | undefined)?.stop_reason,
    ).toBe("requires_approval");
  });
});
