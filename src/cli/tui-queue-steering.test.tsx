/**
 * Exercise queue steering through the production Ink App, not an adapter mock.
 * Executor gates hold the initial stream and its approval continuation open so
 * assertions cannot pass merely because a fast fake turn happened to finish.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { type Instance, render } from "ink";
import stripAnsi from "strip-ansi";
import { setAgentContext } from "@/agent/context";
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
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import { settingsManager } from "@/settings-manager";
import {
  addToMessageQueue,
  clearPendingMessages,
  isQueueBridgeConnected,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { formatTaskNotification } from "@/utils/task-notifications";

class TuiOutputStream extends Writable {
  columns = 120;
  rows = 40;
  isTTY = true;
  text = "";

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    this.text += stripAnsi(chunk.toString());
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
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${description}`);
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

class GatedApprovalExecutor implements HeadlessTurnExecutor {
  readonly inputs: HeadlessTurnExecutorInput[] = [];
  readonly approval = gate();
  readonly completion = gate();
  endTurnEmitted = false;
  readonly submittedAfterEndTurn: boolean[] = [];

  constructor(private readonly filePath: string) {}

  async execute(input: HeadlessTurnExecutorInput) {
    this.inputs.push(input);
    this.submittedAfterEndTurn.push(this.endTurnEmitted);
    const call = this.inputs.length;
    if (call > 2) return createAssistantMessageStream();
    const executor = this;
    return {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        if (call === 1) {
          await executor.approval.promise;
          yield {
            message_type: "approval_request_message",
            tool_call: {
              tool_call_id: "queue-steering-read",
              name: "Read",
              arguments: JSON.stringify({ file_path: executor.filePath }),
            },
          } as LettaStreamingResponse;
          yield {
            message_type: "stop_reason",
            stop_reason: "requires_approval",
          } as LettaStreamingResponse;
        } else {
          await executor.completion.promise;
          for await (const chunk of createAssistantMessageStream()) {
            if (chunk.message_type === "stop_reason") {
              executor.endTurnEmitted = true;
            }
            yield chunk;
          }
        }
      },
    } as unknown as Stream<LettaStreamingResponse>;
  }
}

const renderedInstances = new Set<Instance>();
const executors = new Set<GatedApprovalExecutor>();
let previousBackendMode: BackendMode;
let previousPermissionMode: ReturnType<typeof permissionMode.getMode>;
let previousHome: string | undefined;
let tempHome: string;

beforeEach(async () => {
  previousBackendMode = resolveBackendMode();
  previousPermissionMode = permissionMode.getMode();
  previousHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "letta-tui-steering-"));
  process.env.HOME = tempHome;
  setConfiguredBackendMode("local");
  permissionMode.setMode("standard");
  sessionPermissions.clear();
  clearPendingMessages();
  await settingsManager.reset();
  await settingsManager.initialize();
});

afterEach(async () => {
  for (const instance of renderedInstances) {
    instance.unmount();
    instance.cleanup();
  }
  renderedInstances.clear();
  for (const executor of executors) {
    executor.approval.release();
    executor.completion.release();
  }
  executors.clear();
  setMessageQueueAdder(null);
  clearPendingMessages();
  __testSetBackend(null);
  setConfiguredBackendMode(previousBackendMode);
  permissionMode.setMode(previousPermissionMode);
  sessionPermissions.clear();
  await settingsManager.reset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(tempHome, { recursive: true, force: true });
});

async function renderTestApp(local = false) {
  const filePath = join(tempHome, "steering-fixture.txt");
  writeFileSync(filePath, "queue steering tool result\n");
  const executor = new GatedApprovalExecutor(filePath);
  executors.add(executor);
  // Exercise both ID paths while the injected backend keeps requests deterministic.
  const agentId = local
    ? "agent-local-tui-queue-steering"
    : "agent-tui-queue-steering";
  // Disable skill discovery, including remote shared-memory attachment lookup.
  setAgentContext(agentId, undefined, []);
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
    { stdout, stdin, debug: true, patchConsole: false, exitOnCtrlC: false },
  );
  renderedInstances.add(instance);
  await waitFor(isQueueBridgeConnected, "the production queue bridge");
  addToMessageQueue({ kind: "user", text: "start the original turn" });
  await waitFor(() => executor.inputs.length === 1, "the original turn");
  return { executor, stdin, stdout };
}

function expectToolResult(input: HeadlessTurnExecutorInput | undefined) {
  const body = JSON.stringify(input?.body);
  expect(body).toContain('"type":"approval"');
  expect(body).toContain('"tool_call_id":"queue-steering-read"');
  expect(body).toContain("queue steering tool result");
}

describe("TUI user queue steering", () => {
  test.each([
    ["automatic approval, user only", false, false],
    ["automatic approval, notification bypass", true, false],
    ["manual approval, notification bypass", true, true],
  ] as const)(
    "default defer preserves the user follow-up: %s",
    async (_label, withNotification, manualApproval) => {
      const { executor, stdin, stdout } = await renderTestApp();
      if (manualApproval) sessionPermissions.addRule("Read", "alwaysAsk");
      addToMessageQueue({
        kind: "user",
        text: "user follow-up waits for end_turn",
      });
      if (withNotification) {
        addToMessageQueue({
          kind: "task_notification",
          text: formatTaskNotification({
            taskId: "steering-notification",
            status: "completed",
            summary: "notification bypasses the waiting user",
            result: "background work finished",
            outputFile: "/tmp/queue-steering-notification.log",
          }),
        });
      }

      executor.approval.release();
      if (manualApproval) {
        await waitFor(
          () => stdout.text.includes("No, and tell Letta Code"),
          "the focused Read approval prompt",
        );
        expect(executor.inputs).toHaveLength(1);
        stdin.push("\r");
      }
      await waitFor(
        () => executor.inputs.length === 2,
        "the tool-result continuation",
      );
      expectToolResult(executor.inputs[1]);
      const continuation = JSON.stringify(executor.inputs[1]?.body);
      expect(continuation).not.toContain("user follow-up waits for end_turn");
      if (withNotification) {
        expect(continuation).toContain(
          "notification bypasses the waiting user",
        );
      }
      expect(executor.endTurnEmitted).toBe(false);
      expect(executor.submittedAfterEndTurn).toEqual([false, false]);

      executor.completion.release();
      await waitFor(
        () => executor.inputs.length === 3,
        "the deferred user turn",
      );
      expect(executor.submittedAfterEndTurn).toEqual([false, false, true]);
      const followUp = JSON.stringify(executor.inputs[2]?.body);
      expect(followUp).toContain("user follow-up waits for end_turn");
      expect(followUp).not.toContain('"type":"approval"');
      expect(followUp).not.toContain("notification bypasses the waiting user");
    },
    15_000,
  );

  test.each([false, true])(
    "Ctrl+D steers a queued user follow-up (local=%s)",
    async (local) => {
      const { executor, stdin, stdout } = await renderTestApp(local);
      addToMessageQueue({ kind: "user", text: "explicit user steering" });
      await waitFor(
        () => stdout.text.includes("ctrl+d to release queue"),
        "the default deferred queue hint",
      );
      stdin.push("\u0004");
      await waitFor(
        () => stdout.text.includes("queue sends as soon as possible"),
        "the immediate queue hint after Ctrl+D",
      );

      executor.approval.release();
      await waitFor(
        () => executor.inputs.length === 2,
        "the steered continuation",
      );
      expectToolResult(executor.inputs[1]);
      expect(JSON.stringify(executor.inputs[1]?.body)).toContain(
        "explicit user steering",
      );
      expect(executor.endTurnEmitted).toBe(false);
      expect(executor.submittedAfterEndTurn).toEqual([false, false]);
      const frameStart = stdout.text.length;
      addToMessageQueue({
        kind: "user",
        text: "later input queues by default",
      });
      await waitFor(
        () => stdout.text.slice(frameStart).includes("ctrl+d to release queue"),
        "the next batch defaults back to queueing",
      );
      executor.completion.release();
      await waitFor(
        () => executor.inputs.length === 3,
        "the later queued turn",
      );
      expect(executor.submittedAfterEndTurn).toEqual([false, false, true]);
      expect(JSON.stringify(executor.inputs[2]?.body)).toContain(
        "later input queues by default",
      );
    },
    15_000,
  );
});
