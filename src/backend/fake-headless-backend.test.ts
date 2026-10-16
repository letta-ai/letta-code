import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APIUserAbortError } from "@letta-ai/letta-client/core/error";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationUpdateBody,
} from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { DeterministicToolCallExecutor } from "@/backend/dev/headless-turn-executor";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
  providerLettaChunk,
} from "@/backend/dev/provider-turn-executor";
import { TURN_DID_NOT_COMPLETE } from "@/constants";

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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Stalls inside resolveSystemPromptForTurn so a test can cancel while the
// turn is still in async pre-stream prep (no stream controller registered).
class PromptGatedBackend extends FakeHeadlessBackend {
  readonly promptEntered = deferred();
  readonly promptGate = deferred();
  private gateArmed = true;

  protected override async resolveSystemPromptForTurn(input: unknown) {
    if (this.gateArmed) {
      this.gateArmed = false;
      this.promptEntered.resolve();
      await this.promptGate.promise;
    }
    return super.resolveSystemPromptForTurn(input as never);
  }
}

// Stalls inside executor.execute so a test can cancel during provider
// startup, after the run exists but before its controller is registered.
class DeferredExecutor {
  readonly entered = deferred();
  readonly gate = deferred();
  lastController: AbortController | undefined;
  private gateArmed = true;

  constructor(private readonly inner: ProviderTurnExecutor) {}

  async execute(input: Parameters<ProviderTurnExecutor["execute"]>[0]) {
    if (this.gateArmed) {
      this.gateArmed = false;
      this.entered.resolve();
      await this.gate.promise;
    }
    const stream = await this.inner.execute(input);
    this.lastController = stream.controller as AbortController;
    return stream;
  }
}

// Throws synchronously from execute (validation/setup failure before any
// Promise exists): the run must fail, never strand as an active-run conflict.
class SyncThrowExecutor {
  execute(): never {
    throw new Error("sync executor setup explosion");
  }
}

// Throws synchronously from resolveSystemPromptForTurn: same invariant.
class SyncThrowPromptBackend extends FakeHeadlessBackend {
  protected override resolveSystemPromptForTurn(): never {
    throw new Error("sync prompt setup explosion");
  }
}

describe("FakeHeadlessBackend", () => {
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

  test("rejects a pre-aborted send before persisting input or starting a run", async () => {
    const backend = new FakeHeadlessBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    // Esc landed during pre-stream prep: the cancel found no run to stop,
    // so this send must fail before it can leave an orphaned active run.
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.createConversationMessageStream(
        conversation.id,
        {
          agent_id: "agent-fake-headless",
          messages: [{ role: "user", content: "aborted input" }],
        } as ConversationMessageCreateBody,
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    const page = await backend.listConversationMessages(conversation.id, {
      agent_id: "agent-fake-headless",
    });
    expect(JSON.stringify(page)).not.toContain("aborted input");

    // A later send starts cleanly instead of tripping over an orphaned run.
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("a cancel during prompt prep cancels the run and rejects as a user abort", async () => {
    const backend = new PromptGatedBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const controller = new AbortController();
    const send = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "slow prep" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );
    send.catch(() => {});

    // The turn is parked inside resolveSystemPromptForTurn: the run exists,
    // but no stream controller is registered for cancelConversation to abort.
    await backend.promptEntered.promise;
    controller.abort();
    await backend.cancelConversation(conversation.id);
    backend.promptGate.resolve();

    await expect(send).rejects.toBeInstanceOf(APIUserAbortError);
    const controllers = (
      backend as unknown as {
        runControllerByRunId: Map<string, AbortController>;
      }
    ).runControllerByRunId;
    expect(controllers.size).toBe(0);

    // The cancelled run was completed, so a later send starts cleanly.
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("a cancel during provider startup aborts the late controller and rejects as a user abort", async () => {
    const executor = new DeferredExecutor(
      new ProviderTurnExecutor(new RecordingProviderAdapter()),
    );
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const controller = new AbortController();
    const send = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "slow provider" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );
    send.catch(() => {});

    // The turn is parked inside executor.execute: the run was already
    // cancelled by cancelConversation, but no controller was registered yet.
    await executor.entered.promise;
    controller.abort();
    await backend.cancelConversation(conversation.id);
    executor.gate.resolve();

    await expect(send).rejects.toBeInstanceOf(APIUserAbortError);
    // The late controller is aborted immediately, never registered.
    const controllers = (
      backend as unknown as {
        runControllerByRunId: Map<string, AbortController>;
      }
    ).runControllerByRunId;
    expect(controllers.size).toBe(0);

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("end_turn");
  });

  test("a backend-only cancel during provider startup aborts the late controller without any signal abort", async () => {
    const executor = new DeferredExecutor(
      new ProviderTurnExecutor(new RecordingProviderAdapter()),
    );
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    // No caller signal at all: cancelConversation alone (task-stop/control
    // path) cancels the run while executor.execute is still starting up.
    const send = backend.createConversationMessageStream(conversation.id, {
      agent_id: "agent-fake-headless",
      messages: [{ role: "user", content: "control cancel" }],
    } as ConversationMessageCreateBody);
    send.catch(() => {});

    await executor.entered.promise;
    await backend.cancelConversation(conversation.id);
    executor.gate.resolve();

    await expect(send).rejects.toBeInstanceOf(APIUserAbortError);
    // The late controller is genuinely aborted, not just left unregistered.
    expect(executor.lastController?.signal.aborted).toBe(true);
    const controllers = (
      backend as unknown as {
        runControllerByRunId: Map<string, AbortController>;
      }
    ).runControllerByRunId;
    expect(controllers.size).toBe(0);

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("end_turn");
  });

  test("a prompt prep rejection after Esc unwinds as a user abort and closes the run", async () => {
    const backend = new PromptGatedBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const controller = new AbortController();
    const send = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "prep fails" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );
    send.catch(() => {});

    await backend.promptEntered.promise;
    controller.abort();
    // No cancelConversation: even when the backend cancel never lands, a
    // prep rejection after Esc is a user interrupt and the run must close.
    backend.promptGate.reject(new Error("prompt prep blew up"));

    await expect(send).rejects.toBeInstanceOf(APIUserAbortError);

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("a signal abort preempts a hung prompt prep instead of wedging the send", async () => {
    const backend = new PromptGatedBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const controller = new AbortController();
    const send = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "hung prep" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );
    send.catch(() => {});

    await backend.promptEntered.promise;
    controller.abort();
    // The gate stays unresolved: cancellation must preempt the hung startup,
    // not wait for it. The timer makes a wedge fail fast and legibly.
    await expect(
      Promise.race([
        send,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("send wedged on hung prep")), 500),
        ),
      ]),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    backend.promptGate.resolve();
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("pong");
  });

  test("a backend-only cancel preempts a hung provider startup and aborts the late controller", async () => {
    const executor = new DeferredExecutor(
      new ProviderTurnExecutor(new RecordingProviderAdapter()),
    );
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const send = backend.createConversationMessageStream(conversation.id, {
      agent_id: "agent-fake-headless",
      messages: [{ role: "user", content: "hung provider" }],
    } as ConversationMessageCreateBody);
    send.catch(() => {});

    await executor.entered.promise;
    await backend.cancelConversation(conversation.id);
    // The gate stays unresolved: the send must settle promptly anyway.
    await expect(
      Promise.race([
        send,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("send wedged on hung provider startup")),
            500,
          ),
        ),
      ]),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    // When the hung startup finally hands back a stream, its controller is
    // aborted and never registered.
    executor.gate.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(executor.lastController?.signal.aborted).toBe(true);
    const controllers = (
      backend as unknown as {
        runControllerByRunId: Map<string, AbortController>;
      }
    ).runControllerByRunId;
    expect(controllers.size).toBe(0);

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("end_turn");
  });

  test("a synchronous executor throw fails the run and frees the conversation", async () => {
    const backend = new FakeHeadlessBackend(
      "agent-fake-headless",
      new SyncThrowExecutor(),
    );
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const first = await backend
      .createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "boom" }],
      } as ConversationMessageCreateBody)
      .catch((error: unknown) => error);
    expect((first as Error).message).toContain("sync executor setup explosion");

    // The run failed instead of leaking active: a later send reaches the
    // executor again, not an active-run conflict.
    const second = await backend
      .createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody)
      .catch((error: unknown) => error);
    expect((second as Error).message).toContain(
      "sync executor setup explosion",
    );
    const active = (
      backend as unknown as { activeRunByConversation: Map<string, string> }
    ).activeRunByConversation;
    expect(active.size).toBe(0);
  });

  test("a synchronous prompt-prep throw fails the run and frees the conversation", async () => {
    const backend = new SyncThrowPromptBackend("agent-fake-headless");
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const first = await backend
      .createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "boom" }],
      } as ConversationMessageCreateBody)
      .catch((error: unknown) => error);
    expect((first as Error).message).toContain("sync prompt setup explosion");

    const second = await backend
      .createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody)
      .catch((error: unknown) => error);
    expect((second as Error).message).toContain("sync prompt setup explosion");
    const active = (
      backend as unknown as { activeRunByConversation: Map<string, string> }
    ).activeRunByConversation;
    expect(active.size).toBe(0);
  });

  test("a provider startup rejection after Esc unwinds as a user abort and keeps the run cancelled", async () => {
    const executor = new DeferredExecutor(
      new ProviderTurnExecutor(new RecordingProviderAdapter()),
    );
    const backend = new FakeHeadlessBackend("agent-fake-headless", executor);
    const conversation = await backend.createConversation({
      agent_id: "agent-fake-headless",
    });

    const controller = new AbortController();
    const send = backend.createConversationMessageStream(
      conversation.id,
      {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "provider fails" }],
      } as ConversationMessageCreateBody,
      { signal: controller.signal },
    );
    send.catch(() => {});

    await executor.entered.promise;
    controller.abort();
    await backend.cancelConversation(conversation.id);
    executor.gate.reject(new Error("provider startup 500"));

    // The raw provider error must not escape as a stream error, and failRun
    // must not overwrite the cancelled state.
    await expect(send).rejects.toBeInstanceOf(APIUserAbortError);

    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: "agent-fake-headless",
        messages: [{ role: "user", content: "after" }],
      } as ConversationMessageCreateBody),
    );
    expect(JSON.stringify(chunks)).toContain("end_turn");
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
