import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bash } from "@/tools/impl/bash";
import { exec_command } from "@/tools/impl/exec-command";
import { killBackgroundProcess } from "@/tools/impl/kill-bash";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import {
  addToMessageQueue,
  clearPendingMessages,
} from "@/utils/message-queue-bridge";
import { closeListenerConnection, openListenerConnection } from "./connection";
import { emitInitialConnectionState } from "./connection-state-sync";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { getConversationRuntimeKey, setActiveRuntime } from "./runtime";
import type { LocalTransport } from "./transport";
import type { StartListenerOptions } from "./types";

const AGENT_ID = "agent-bg-evict";
const CONVERSATION_ID = "conv-bg-evict";

class MockTransport implements LocalTransport {
  readonly kind = "local" as const;
  readonly bufferedAmount = 0;
  readonly sent: string[] = [];

  isOpen(): boolean {
    return true;
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const options: StartListenerOptions = {
  connectionId: "conn-bg-evict",
  wsUrl: "ws://test",
  deviceId: "device-bg-evict",
  connectionName: "test",
  onConnected() {},
  onDisconnected() {},
  onError() {},
};

async function waitFor(condition: () => boolean, label: string) {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${label}`);
    await Bun.sleep(10);
  }
}

function reportedProcessIds(transport: MockTransport): string[] {
  return transport.sent
    .map((frame) => JSON.parse(frame))
    .filter(
      (message) =>
        message.type === "update_device_status" &&
        message.runtime?.conversation_id === CONVERSATION_ID,
    )
    .flatMap((message) =>
      (message.device_status.background_processes ?? []).map(
        (process: { process_id: string }) => process.process_id,
      ),
    );
}

let fixtureDir: string | undefined;

afterEach(() => {
  for (const proc of backgroundProcesses.values()) {
    try {
      proc.process.kill("SIGTERM");
    } catch {
      // Already exited.
    }
  }
  backgroundProcesses.clear();
  clearPendingMessages();
  setActiveRuntime(null);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

test("a conversation with running background Bash stays held and is re-reported on reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bg-evict-"));
  fixtureDir = dir;
  const releaseFile = join(dir, "release");
  const script = join(dir, "wait.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releaseFile)})) {
    clearInterval(timer);
    process.exit(0);
  }
}, 20);`,
  );

  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtimeKey = getConversationRuntimeKey(AGENT_ID, CONVERSATION_ID);
  let bashId: string | undefined;
  let turns = 0;
  installProcessEventRouting({
    runtime: listener,
    processTransport: new MockTransport(),
    opts: options,
    processQueuedTurn: async () => {
      turns += 1;
      if (turns > 1) return;
      // The turn starts background work and ends while it is still running.
      const result = await bash({
        command: `"${process.execPath}" "${script}"`,
        run_in_background: true,
        parentScope: { agentId: AGENT_ID, conversationId: CONVERSATION_ID },
      });
      bashId = result.content[0]?.text.match(/bash_\d+/)?.[0];
    },
  });

  try {
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    addToMessageQueue({
      kind: "task_notification",
      text: "<task-notification>start</task-notification>",
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });
    await waitFor(() => turns === 1 && bashId !== undefined, "first turn");
    await waitFor(
      () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
      "queue pump to finish",
    );

    // Turn ended, but the background shell still belongs to this conversation.
    expect(listener.conversationRuntimes.get(runtimeKey)).toBe(runtime);

    // A new connection re-reports the running process for this conversation.
    const transport = new MockTransport();
    const connection = openListenerConnection({
      runtime: listener,
      connectionId: "conn-bg-evict-2",
      writer: transport,
      options: { ...options, connectionId: "conn-bg-evict-2" },
    });
    expect(
      await emitInitialConnectionState(listener, connection, transport, {
        refreshGitContext: async () => {},
      }),
    ).toBe(true);
    expect(reportedProcessIds(transport)).toContain(bashId as string);
    // Drop the sync-only connection so the notification turn is not gated on
    // a subscribed recipient for it.
    closeListenerConnection(listener, "conn-bg-evict-2");

    // Once the shell exits and its notification turn runs, the conversation
    // is released.
    writeFileSync(releaseFile, "");
    await waitFor(() => turns === 2, "notification turn");
    await waitFor(
      () => !listener.conversationRuntimes.has(runtimeKey),
      "conversation eviction",
    );
  } finally {
    clearProcessServices(listener);
  }
}, 15_000);

function writeWaitScript(): { script: string; releaseFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "bg-evict-"));
  fixtureDir = dir;
  const releaseFile = join(dir, "release");
  const script = join(dir, "wait.cjs");
  writeFileSync(
    script,
    `const fs = require("node:fs");
setInterval(() => {
  if (fs.existsSync(${JSON.stringify(releaseFile)})) process.exit(0);
}, 20);`,
  );
  return { script, releaseFile };
}

/** Run one turn that leaves an exec_command session running in the background. */
async function holdConversationWithExecSession(script: string) {
  const listener = createRuntime();
  setActiveRuntime(listener);
  const runtimeKey = getConversationRuntimeKey(AGENT_ID, CONVERSATION_ID);
  let turnDone = false;
  installProcessEventRouting({
    runtime: listener,
    processTransport: new MockTransport(),
    opts: options,
    processQueuedTurn: async () => {
      if (turnDone) return;
      await exec_command({
        cmd: `"${process.execPath}" "${script}"`,
        yield_time_ms: 250,
        parentScope: { agentId: AGENT_ID, conversationId: CONVERSATION_ID },
      });
      turnDone = true;
    },
  });
  const runtime = getOrCreateScopedRuntime(listener, AGENT_ID, CONVERSATION_ID);
  addToMessageQueue({
    kind: "task_notification",
    text: "<task-notification>start</task-notification>",
    agentId: AGENT_ID,
    conversationId: CONVERSATION_ID,
  });
  await waitFor(() => turnDone, "exec turn");
  await waitFor(
    () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
    "queue pump to finish",
  );
  const sessionId = [...backgroundProcesses.entries()].find(
    ([, proc]) =>
      proc.runtimeScope?.conversationId === CONVERSATION_ID &&
      proc.status === "running",
  )?.[0];
  expect(sessionId).toBeDefined();
  expect(listener.conversationRuntimes.get(runtimeKey)).toBe(runtime);
  return { listener, runtimeKey, sessionId: sessionId as string };
}

test("a stopped exec_command session releases its held conversation", async () => {
  const { script } = writeWaitScript();
  const { listener, runtimeKey, sessionId } =
    await holdConversationWithExecSession(script);
  try {
    // TaskStop must not leave the conversation held after the session ends.
    expect(killBackgroundProcess(sessionId)).toBe(true);
    await waitFor(
      () => !listener.conversationRuntimes.has(runtimeKey),
      "conversation eviction",
    );
  } finally {
    clearProcessServices(listener);
  }
}, 15_000);

test("an exec_command session that exits with its notification suppressed releases its held conversation", async () => {
  const { script, releaseFile } = writeWaitScript();
  const { listener, runtimeKey, sessionId } =
    await holdConversationWithExecSession(script);
  try {
    const proc = backgroundProcesses.get(sessionId);
    if (!proc) throw new Error("exec session missing");
    proc.completionNotificationSuppressed = true;
    writeFileSync(releaseFile, "");
    await waitFor(() => proc.status !== "running", "session exit");
    await waitFor(
      () => !listener.conversationRuntimes.has(runtimeKey),
      "conversation eviction",
    );
  } finally {
    clearProcessServices(listener);
  }
}, 15_000);
