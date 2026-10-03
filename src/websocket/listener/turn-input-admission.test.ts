import { expect, spyOn, test } from "bun:test";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend } from "@/backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
} from "@/backend/dev/headless-turn-executor";
import { LocalBackend } from "@/backend/local/local-backend";
import { settingsManager } from "@/settings-manager";
import { TestDirectory } from "@/test-utils/test-fs";
import {
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { setActiveRuntime } from "./runtime";
import type { ListenerTransport } from "./transport";
import { handleIncomingMessage } from "./turn";

const socket: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function installConnection(
  listener: ReturnType<typeof createRuntime>,
  agentId: string,
  conversationId: string,
): void {
  const options = {
    connectionId: "admission-test",
    wsUrl: "ws://test",
    deviceId: "admission-device",
    connectionName: "Admission test",
    onConnected: () => {},
    onDisconnected: () => {},
    onError: () => {},
  };
  openListenerConnection({
    runtime: listener,
    connectionId: options.connectionId,
    writer: socket,
    options,
  }).initialized = true;
  subscribeListenerConnection(listener, options.connectionId, {
    agent_id: agentId,
    conversation_id: conversationId,
  });
}

test("a reset winning during Core admission cannot invoke the ownership callback", async () => {
  const directory = new TestDirectory();
  const backend = new LocalBackend({
    storageDir: directory.path,
    executionMode: "deterministic",
    memfsEnabled: false,
  });
  let conversationId: string | null = null;
  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Admission reset",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    conversationId = conversation.id;
    const admission = deferred<Stream<LettaStreamingResponse>>();
    const request = spyOn(
      backend,
      "createConversationMessageStream",
    ).mockReturnValue(admission.promise);
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    installConnection(listener, agent.id, conversation.id);
    setActiveRuntime(listener);
    let accepted = 0;
    const turn = handleIncomingMessage(
      {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "deferred admission" }],
      },
      socket,
      runtime,
      undefined,
      "admission-test",
      undefined,
      undefined,
      undefined,
      () => {
        accepted += 1;
      },
    );
    while (request.mock.calls.length === 0) await Bun.sleep(1);
    runtime.turnLifecycle.reset();
    const controller = new AbortController();
    admission.resolve({
      controller,
      async *[Symbol.asyncIterator]() {
        yield {
          message_type: "stop_reason",
          run_id: "stale-run",
          seq_id: 1,
          stop_reason: "end_turn",
        } as LettaStreamingResponse;
      },
    } as unknown as Stream<LettaStreamingResponse>);
    await turn;

    expect(accepted).toBe(0);
    expect(controller.signal.aborted).toBe(true);
  } finally {
    if (conversationId) await backend.cancelConversation(conversationId);
    setActiveRuntime(null);
    __testSetBackend(null);
    directory.cleanup();
  }
});

class PendingThenSuccessfulExecutor implements HeadlessTurnExecutor {
  executions = 0;

  async execute(): Promise<Stream<LettaStreamingResponse>> {
    this.executions += 1;
    if (this.executions > 1) {
      return createAssistantMessageStream({
        content: [{ type: "text", text: "retry completed" }],
      });
    }
    const controller = new AbortController();
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        await new Promise<void>((_resolve, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        });
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}

test("ownership callback failure settles the admitted run before a retry", async () => {
  const directory = new TestDirectory();
  const executor = new PendingThenSuccessfulExecutor();
  const backend = new LocalBackend({
    storageDir: directory.path,
    memfsEnabled: false,
    executor,
  });
  let conversationId: string | null = null;
  try {
    __testSetBackend(backend);
    await settingsManager.initialize();
    const agent = await backend.createAgent({
      name: "Admission cleanup",
      model: "anthropic/claude-sonnet-4-6",
    });
    settingsManager.setMemfsEnabled(agent.id, false);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    conversationId = conversation.id;
    const listener = createRuntime();
    const runtime = getOrCreateScopedRuntime(
      listener,
      agent.id,
      conversation.id,
    );
    installConnection(listener, agent.id, conversation.id);
    setActiveRuntime(listener);

    await handleIncomingMessage(
      {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "first recovery" }],
      },
      socket,
      runtime,
      undefined,
      "admission-test",
      undefined,
      undefined,
      undefined,
      () => {
        throw new Error("simulated recovery ledger failure");
      },
    );
    expect(await backend.retrieveRun("local-run-1")).toMatchObject({
      status: "cancelled",
      stop_reason: "cancelled",
    });

    await handleIncomingMessage(
      {
        type: "message",
        agentId: agent.id,
        conversationId: conversation.id,
        messages: [{ role: "user", content: "retry recovery" }],
      },
      socket,
      runtime,
      undefined,
      "admission-test",
    );
    expect(await backend.retrieveRun("local-run-2")).toMatchObject({
      status: "completed",
      stop_reason: "end_turn",
    });
    expect(executor.executions).toBe(2);
  } finally {
    if (conversationId) await backend.cancelConversation(conversationId);
    setActiveRuntime(null);
    __testSetBackend(null);
    directory.cleanup();
  }
});
