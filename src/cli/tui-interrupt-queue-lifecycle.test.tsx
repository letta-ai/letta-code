/**
 * Regression tests for the TUI interrupt -> queue handoff (issue #4168).
 *
 * A Monitor `task_notification` queued while a turn is active must start the
 * next turn on its own once an Esc cancellation has settled. The interrupted
 * turn's finally block owns that `cancelling -> idle` transition and wakes the
 * dequeue effect; no timer or later user prompt may be required.
 *
 * The typed-prompt case matters: a turn started from the queue bridge is woken
 * by the dequeue effect's own completion callback, which masked the bug. A
 * turn started by typing has no such callback.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await sleep(10);
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

/**
 * First turn: a stream that yields nothing until aborted, then ends only when
 * the test releases it (so the test controls when cancellation settles).
 * Every later turn: an immediate assistant reply.
 */
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
let previousHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  clearPendingMessages();
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-interrupt-"));
  process.env.HOME = tempHome;
  await settingsManager.reset();
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
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }
  rmSync(tempHome, { recursive: true, force: true });
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

async function typePrompt(stdin: NodeJS.ReadStream, text: string) {
  // Give the input component a moment to mount before typing.
  await sleep(200);
  stdin.push(text);
  await sleep(50);
  stdin.push("\r");
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

  test("typed prompt, notification queued, Esc: the notification drains once cancellation settles", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("queued before Esc"),
    });
    stdin.push("\u001b");
    await executor.abortObserved;

    // Cancellation has not settled yet: nothing may start a replacement turn.
    await sleep(100);
    expect(executor.inputs).toHaveLength(1);

    executor.settleInterruptedTurn();
    await waitFor(
      () => executor.inputs.length === 2,
      "the queued notification turn after cancellation settled",
    );
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "queued before Esc",
    );
  }, 15_000);

  test("typed prompt, Esc, then a notification that arrives after cancellation settled", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");

    stdin.push("\u001b");
    await executor.abortObserved;
    executor.settleInterruptedTurn();
    await sleep(200);

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("arrived after Esc"),
    });
    await waitFor(
      () => executor.inputs.length === 2,
      "the notification turn after an already-settled Esc",
    );
    expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
      "arrived after Esc",
    );
  }, 15_000);

  test("Esc parks a typed queued message; a notification still drains; Enter resumes", async () => {
    const executor = new DelayedInterruptExecutor();
    const { stdin } = await renderTestApp(executor);

    await typePrompt(stdin, "start turn");
    await waitFor(() => executor.inputs.length === 1, "the typed initial turn");
    // A user message queued behind the active turn (source: user).
    addToMessageQueue({ kind: "user", text: "queued while busy" });

    addToMessageQueue({
      kind: "task_notification",
      text: monitorNotification("arrived during turn"),
    });
    stdin.push("\u001b");
    await executor.abortObserved;
    executor.settleInterruptedTurn();

    // The notification starts a turn on its own; the parked user message does not.
    await waitFor(
      () => executor.inputs.length === 2,
      "the notification turn after Esc",
    );
    const notificationTurn = JSON.stringify(executor.inputs[1]?.body);
    expect(notificationTurn).toContain("arrived during turn");
    expect(notificationTurn).not.toContain("queued while busy");
    await sleep(300);
    expect(executor.inputs).toHaveLength(2);

    // Enter on the empty input is the TUI's Resume.
    stdin.push("\r");
    await waitFor(
      () => executor.inputs.length === 3,
      "the parked message to run after Enter",
    );
    expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
      "queued while busy",
    );
  }, 20_000);
});
