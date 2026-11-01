import { expect, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend } from "@/backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { TestDirectory } from "@/test-utils/test-fs";
import { handleAbortMessageInput } from "./control-inputs";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { finishListenerTurn } from "./turn-terminal";
import type { StartListenerOptions } from "./types";

class PendingThenSuccessfulExecutor implements HeadlessTurnExecutor {
  executions = 0;

  async execute(): Promise<Stream<LettaStreamingResponse>> {
    this.executions += 1;
    if (this.executions > 1) {
      return createAssistantMessageStream({
        content: [{ type: "text", text: "follow-up completed" }],
      });
    }

    const controller = new AbortController();
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("interrupted", "AbortError")),
            { once: true },
          );
        });
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}

const socket: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(5);
  }
}

async function exerciseCancellation(withAgentOwner: boolean): Promise<void> {
  const directory = new TestDirectory();
  const executor = new PendingThenSuccessfulExecutor();
  const backend = new LocalBackend({
    storageDir: directory.path,
    memfsEnabled: false,
    executor,
  });
  __testSetBackend(backend);
  const listener = createRuntime();
  setActiveRuntime(listener);

  let conversationId: string | null = null;
  try {
    const agent = withAgentOwner
      ? await backend.createAgent({
          name: "abort comparator",
          model: "openai/gpt-5.6-luna",
          system: "Cancellation test",
          tools: [],
          include_base_tools: false,
        } as never)
      : null;
    const conversation = withAgentOwner
      ? await backend.createConversation({ agent_id: agent?.id } as never)
      : await backend.createEphemeralConversation({
          model: "openai/gpt-5.6-luna",
          system: "Cancellation test",
        });
    conversationId = conversation.id;
    const stream = await backend.createConversationMessageStream(
      conversation.id,
      {
        messages: [{ role: "user", content: "wait until interrupted" }],
      } as never,
    );
    const streamResult = (async () => {
      try {
        for await (const _chunk of stream) {
          // The first deterministic provider stream remains pending.
        }
        return "completed";
      } catch (error) {
        return error instanceof Error ? error.name : "error";
      }
    })();

    const runtime = getOrCreateScopedRuntime(
      listener,
      agent?.id ?? null,
      conversation.id,
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: directory.path,
    });
    runtime.turnLifecycle.setRunId(lease, "local-run-1");

    expect(
      await handleAbortMessageInput(listener, {
        command: {
          type: "abort_message",
          runtime: {
            agent_id: agent?.id ?? null,
            conversation_id: conversation.id,
          },
          run_id: "local-run-1",
        },
        socket,
        opts: {} as StartListenerOptions,
        processQueuedTurn: async () => {},
      }),
    ).toBe(true);
    expect(lease.signal.aborted).toBe(true);

    finishListenerTurn(runtime, lease, {
      stopReason: "cancelled",
      socket,
      agentId: agent?.id ?? null,
      conversationId: conversation.id,
    });
    expect(runtime.turnLifecycle.kind).toBe("cancelling");

    await waitFor(
      async () =>
        (
          (await backend.retrieveRun("local-run-1")) as unknown as {
            status: string;
          }
        ).status === "cancelled",
      "backend run did not settle as cancelled",
    );
    await waitFor(
      () => runtime.turnLifecycle.kind === "idle",
      "turn lifecycle did not settle after backend cancellation",
    );
    expect(await streamResult).toBe("AbortError");
    expect(await backend.retrieveRun("local-run-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });

    const followUp = await backend.createConversationMessageStream(
      conversation.id,
      {
        messages: [{ role: "user", content: "continue" }],
      } as never,
    );
    for await (const _chunk of followUp) {
      // Drain the complete deterministic follow-up.
    }
    expect(await backend.retrieveRun("local-run-2")).toMatchObject({
      status: "completed",
      stop_reason: "end_turn",
    });
    expect(executor.executions).toBe(2);
  } finally {
    if (conversationId) {
      await backend.cancelConversation(conversationId);
    }
    setActiveRuntime(null);
    __testSetBackend(null);
    directory.cleanup();
  }
}

test("abort cancels the exact agent_id:null conversation run and permits a follow-up", async () => {
  await exerciseCancellation(false);
});

test("abort preserves run-scoped cancellation for an agent-owned conversation", async () => {
  await exerciseCancellation(true);
});

test("conversation-scoped run cancellation cannot select another conversation's run", async () => {
  const directory = new TestDirectory();
  const backend = new LocalBackend({
    storageDir: directory.path,
    memfsEnabled: false,
    executor: new PendingThenSuccessfulExecutor(),
  });
  let firstConversationId: string | null = null;
  let secondConversationId: string | null = null;
  try {
    const first = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "First conversation",
    });
    const second = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "Second conversation",
    });
    firstConversationId = first.id;
    secondConversationId = second.id;
    await backend.createConversationMessageStream(first.id, {
      messages: [{ role: "user", content: "wait" }],
    } as never);
    await backend.createConversationMessageStream(second.id, {
      messages: [{ role: "user", content: "complete later" }],
    } as never);

    const mismatchedCancellation = (await backend.cancelConversationRun(
      first.id,
      "local-run-2",
    )) as unknown as Record<string, string>;
    expect(mismatchedCancellation).toEqual({ "local-run-2": "failed" });
    expect(await backend.retrieveRun("local-run-1")).toMatchObject({
      status: "running",
      conversation_id: first.id,
    });
    expect(await backend.retrieveRun("local-run-2")).toMatchObject({
      status: "running",
      conversation_id: second.id,
    });
  } finally {
    if (firstConversationId) {
      await backend.cancelConversation(firstConversationId);
    }
    if (secondConversationId) {
      await backend.cancelConversation(secondConversationId);
    }
    directory.cleanup();
  }
});

async function abortWithoutTurn(
  listener: ReturnType<typeof createRuntime>,
  runtime: { agent_id: string | null; conversation_id: string },
  runId?: string,
): Promise<boolean> {
  return handleAbortMessageInput(listener, {
    command: {
      type: "abort_message",
      runtime,
      ...(runId ? { run_id: runId } : {}),
    },
    socket,
    opts: {} as StartListenerOptions,
    processQueuedTurn: async () => {},
  });
}

test("abort with no listener turn cancels an orphaned local run so the next send succeeds", async () => {
  const directory = new TestDirectory();
  const executor = new PendingThenSuccessfulExecutor();
  const backend = new LocalBackend({
    storageDir: directory.path,
    memfsEnabled: false,
    executor,
  });
  __testSetBackend(backend);
  const listener = createRuntime();
  setActiveRuntime(listener);
  let conversationId: string | null = null;
  try {
    const agent = await backend.createAgent({
      name: "orphaned run",
      model: "openai/gpt-5.6-luna",
      system: "Orphaned run test",
      tools: [],
      include_base_tools: false,
    } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    conversationId = conversation.id;
    // Started but never consumed to a stop reason, with no listener turn.
    await backend.createConversationMessageStream(conversation.id, {
      messages: [{ role: "user", content: "never consumed" }],
    } as never);
    await expect(
      backend.createConversationMessageStream(conversation.id, {
        messages: [{ role: "user", content: "blocked" }],
      } as never),
    ).rejects.toThrow("already has an active run (local-run-1)");

    const runtime = { agent_id: agent.id, conversation_id: conversation.id };
    expect(await abortWithoutTurn(listener, runtime)).toBe(true);
    expect(await backend.retrieveRun("local-run-1")).toMatchObject({
      status: "cancelled",
    });
    // Nothing left to cancel.
    expect(await abortWithoutTurn(listener, runtime)).toBe(false);

    const followUp = await backend.createConversationMessageStream(
      conversation.id,
      { messages: [{ role: "user", content: "continue" }] } as never,
    );
    for await (const _chunk of followUp) {
      // Drain the deterministic follow-up.
    }
    expect(await backend.retrieveRun("local-run-2")).toMatchObject({
      status: "completed",
    });
  } finally {
    if (conversationId) await backend.cancelConversation(conversationId);
    setActiveRuntime(null);
    __testSetBackend(null);
    directory.cleanup();
  }
});

test("abort with no listener turn cancels only the requested orphaned run", async () => {
  const directory = new TestDirectory();
  const backend = new LocalBackend({
    storageDir: directory.path,
    memfsEnabled: false,
    executor: new PendingThenSuccessfulExecutor(),
  });
  __testSetBackend(backend);
  const listener = createRuntime();
  setActiveRuntime(listener);
  const conversationIds: string[] = [];
  try {
    const first = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "First",
    });
    const second = await backend.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "Second",
    });
    conversationIds.push(first.id, second.id);
    await backend.createConversationMessageStream(first.id, {
      messages: [{ role: "user", content: "wait" }],
    } as never);
    await backend.createConversationMessageStream(second.id, {
      messages: [{ role: "user", content: "wait" }],
    } as never);

    const runtime = { agent_id: null, conversation_id: first.id };
    // Another conversation's run id is not this conversation's to cancel.
    expect(await abortWithoutTurn(listener, runtime, "local-run-2")).toBe(
      false,
    );
    expect(await abortWithoutTurn(listener, runtime, "local-run-1")).toBe(true);
    expect(await backend.retrieveRun("local-run-1")).toMatchObject({
      status: "cancelled",
    });
    expect(await backend.retrieveRun("local-run-2")).toMatchObject({
      status: "running",
    });
  } finally {
    for (const id of conversationIds) await backend.cancelConversation(id);
    setActiveRuntime(null);
    __testSetBackend(null);
    directory.cleanup();
  }
});

test("abort with no listener turn leaves API backend runs alone", async () => {
  const calls: string[] = [];
  const record =
    (name: string) =>
    async (..._args: unknown[]) => {
      calls.push(name);
      return {};
    };
  __testSetBackend({
    capabilities: { localModelCatalog: false },
    latestConversationRun: async () => {
      calls.push("latestConversationRun");
      return { id: "run-remote", status: "running" };
    },
    retrieveRun: record("retrieveRun"),
    cancelRun: record("cancelRun"),
    cancelConversation: record("cancelConversation"),
    cancelConversationRun: record("cancelConversationRun"),
  } as never);
  const listener = createRuntime();
  setActiveRuntime(listener);
  try {
    const runtime = { agent_id: "agent-remote", conversation_id: "conv-1" };
    expect(await abortWithoutTurn(listener, runtime)).toBe(false);
    expect(await abortWithoutTurn(listener, runtime, "run-remote")).toBe(false);
    expect(calls).toEqual([]);
  } finally {
    setActiveRuntime(null);
    __testSetBackend(null);
  }
});
