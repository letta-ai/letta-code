import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { type Instance, render } from "ink";
import { __testSetBackend } from "@/backend";
import {
  type BackendMode,
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  createAssistantMessageStream,
  type HeadlessTurnExecutor,
  type HeadlessTurnExecutorInput,
} from "@/backend/dev/headless-turn-executor";
import { App } from "@/cli/App";
import { settingsManager } from "@/settings-manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

class TuiOutputStream extends Writable {
  columns = 100;
  rows = 30;
  isTTY = true;

  override _write(
    _chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    callback();
  }
}

function createInputStream(): NodeJS.ReadStream {
  const input = new Readable({ read() {} }) as NodeJS.ReadStream;
  input.isTTY = true;
  input.setRawMode = () => input;
  input.ref = () => input;
  input.unref = () => input;
  return input;
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) {
    throw new Error(`Timed out waiting for ${description}`);
  }
}

function monitorNotification(summary: string): string {
  return formatTaskNotification({
    taskId: "monitor-test",
    status: "completed",
    summary,
    result: "done",
    outputFile: "/tmp/monitor-test.log",
  });
}

class DelayedInterruptExecutor implements HeadlessTurnExecutor {
  readonly inputs: HeadlessTurnExecutorInput[] = [];
  private releaseInterruptedTurn: (() => void) | null = null;
  private readonly interruptedTurnReleased = new Promise<void>((resolve) => {
    this.releaseInterruptedTurn = resolve;
  });
  private resolveAbortObserved: (() => void) | null = null;
  readonly abortObserved = new Promise<void>((resolve) => {
    this.resolveAbortObserved = resolve;
  });

  async execute(input: HeadlessTurnExecutorInput) {
    this.inputs.push(input);
    if (this.inputs.length > 1) {
      return createAssistantMessageStream();
    }

    const controller = new AbortController();
    const abortObserved = this.resolveAbortObserved;
    const interruptedTurnReleased = this.interruptedTurnReleased;
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        if (!controller.signal.aborted) {
          await new Promise<void>((resolve) => {
            controller.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
          });
        }
        abortObserved?.();
        await interruptedTurnReleased;
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }

  settleInterruptedTurn(): void {
    this.releaseInterruptedTurn?.();
    this.releaseInterruptedTurn = null;
  }
}

const renderedInstances = new Set<Instance>();
let previousBackendMode: BackendMode;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  clearPendingMessages();
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  await settingsManager.reset();
});

async function renderTestApp(executor: HeadlessTurnExecutor): Promise<{
  backend: FakeHeadlessBackend;
  stdin: NodeJS.ReadStream;
}> {
  const agentId = "agent-tui-interrupt-queue";
  const backend = new FakeHeadlessBackend(agentId, executor);
  __testSetBackend(backend);
  const agentState = await backend.retrieveAgent(agentId);
  const conversation = await backend.createConversation({ agent_id: agentId });
  const stdin = createInputStream();
  const stdout = new TuiOutputStream() as TuiOutputStream & NodeJS.WriteStream;
  const instance = render(
    <App
      agentId={agentId}
      agentState={agentState}
      conversationId={conversation.id}
      modsDisabled
      systemInfoReminderEnabled={false}
    />,
    {
      stdout,
      stdin,
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the TUI queue bridge to mount");
  return { backend, stdin };
}

describe("TUI interrupt queue lifecycle", () => {
  test("an idle Monitor notification starts an agent turn without user input", async () => {
    const executor = new DelayedInterruptExecutor();
    await renderTestApp(executor);

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("idle monitor completion"),
    });

    await waitFor(() => executor.inputs.length === 1, "the notification turn");
    expect(JSON.stringify(executor.inputs[0]?.body)).toContain(
      "idle monitor completion",
    );
    executor.settleInterruptedTurn();
  });

  test("a Monitor notification queued before Esc wakes only after cancellation settles", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    addToMessageQueue({ kind: "user", text: "start turn" });
    await waitFor(() => executor.inputs.length === 1, "the initial turn");

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("queued before Esc"),
    });
    stdin.push("\u001b");
    await executor.abortObserved;

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(executor.inputs).toHaveLength(1);

    executor.settleInterruptedTurn();
    await waitFor(
      () => executor.inputs.length === 2,
      "the queued notification turn after cancellation",
    );
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "queued before Esc",
    );
  }, 15_000);
});
