import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBackendMode,
  setConfiguredBackendMode,
} from "@/backend/backend-mode";
import { MANAGED_CLOUD_RUNTIME_ENV } from "@/managed-cloud-runtime";
import { bash } from "@/tools/impl/bash";
import { exec_command } from "@/tools/impl/exec-command";
import { killBackgroundProcess } from "@/tools/impl/kill-bash";
import { monitor } from "@/tools/impl/monitor";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import { stopConversationBackground } from "@/tools/impl/stop-conversation-background";
import {
  addToMessageQueue,
  clearPendingMessages,
} from "@/utils/message-queue-bridge";
import {
  closeListenerConnection,
  openListenerConnection,
  subscribeListenerConnection,
} from "./connection";
import { emitInitialConnectionState } from "./connection-state-sync";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime, stopRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
import { buildDeviceStatus } from "./protocol-outbound";
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
let previousBackendMode = resolveBackendMode();
let previousManagedCloud: string | undefined;

beforeEach(() => {
  previousBackendMode = resolveBackendMode();
  setConfiguredBackendMode("local");
  previousManagedCloud = process.env[MANAGED_CLOUD_RUNTIME_ENV];
  delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
});

afterEach(() => {
  setConfiguredBackendMode(previousBackendMode);
  if (previousManagedCloud === undefined) {
    delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
  } else {
    process.env[MANAGED_CLOUD_RUNTIME_ENV] = previousManagedCloud;
  }
  for (const proc of backgroundProcesses.values()) {
    try {
      proc.process.kill("SIGTERM");
    } catch {}
  }
  backgroundProcesses.clear();
  clearPendingMessages();
  setActiveRuntime(null);
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  fixtureDir = undefined;
});

const scope = { agentId: AGENT_ID, conversationId: CONVERSATION_ID };

async function launchBackgroundWork(kind: "bash" | "monitor", script: string) {
  const command = `"${process.execPath}" "${script}"`;
  if (kind === "monitor") {
    return (await monitor({ command, description: "wait", parentScope: scope }))
      .taskId;
  }
  const result = await bash({
    command,
    run_in_background: true,
    parentScope: scope,
  });
  return result.content[0]?.text.match(/bash_\d+/)?.[0];
}

test.each(["bash", "monitor"] as const)(
  "a conversation with running %s stays held and is re-reported on reconnect",
  async (kind) => {
    const { script, releaseFile } = writeWaitScript();

    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtimeKey = getConversationRuntimeKey(AGENT_ID, CONVERSATION_ID);
    let taskId: string | undefined;
    let turns = 0;
    installProcessEventRouting({
      runtime: listener,
      processTransport: new MockTransport(),
      opts: options,
      processQueuedTurn: async () => {
        turns += 1;
        if (turns > 1) return;
        taskId = await launchBackgroundWork(kind, script);
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
      await waitFor(() => turns === 1 && taskId !== undefined, "first turn");
      await waitFor(
        () => !runtime.queuePumpActive && !runtime.queuePumpScheduled,
        "queue pump to finish",
      );

      expect(listener.conversationRuntimes.get(runtimeKey)).toBe(runtime);

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
      expect(reportedProcessIds(transport)).toContain(taskId as string);
      if (kind === "monitor") {
        expect(transport.sent.map((frame) => JSON.parse(frame))).toContainEqual(
          expect.objectContaining({
            type: "update_device_status",
            device_status: expect.objectContaining({
              active_non_persistent_monitor_count: 1,
            }),
          }),
        );
      }
      closeListenerConnection(listener, "conn-bg-evict-2");

      writeFileSync(releaseFile, "");
      await waitFor(() => turns === 2, "notification turn");
      await waitFor(
        () => !listener.conversationRuntimes.has(runtimeKey),
        "conversation eviction",
      );
    } finally {
      clearProcessServices(listener);
    }
  },
  15_000,
);

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
  const { script } = writeWaitScript();
  const { listener, runtimeKey, sessionId } =
    await holdConversationWithExecSession(script);
  try {
    const proc = backgroundProcesses.get(sessionId);
    if (!proc) throw new Error("exec session missing");
    await stopConversationBackground({
      agentId: AGENT_ID,
      conversationId: CONVERSATION_ID,
    });
    await waitFor(() => proc.status !== "running", "session exit");
    await waitFor(
      () => !listener.conversationRuntimes.has(runtimeKey),
      "conversation eviction",
    );
  } finally {
    clearProcessServices(listener);
  }
}, 15_000);

test.each(["bash", "monitor"] as const)(
  "%s completion sends its queued notification before device status clears",
  async (kind) => {
    const { script, releaseFile } = writeWaitScript();
    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    const lease = runtime.turnLifecycle.begin({
      origin: "message",
      workingDirectory: "/tmp",
    });
    const transport = new MockTransport();
    const connection = openListenerConnection({
      runtime: listener,
      connectionId: options.connectionId,
      writer: transport,
      options,
    });
    connection.initialized = true;
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: AGENT_ID,
      conversation_id: CONVERSATION_ID,
    });
    installProcessEventRouting({
      runtime: listener,
      processTransport: transport,
      opts: options,
      processQueuedTurn: async () => {},
    });
    try {
      const taskId = await launchBackgroundWork(kind, script);
      if (kind === "monitor") {
        await waitFor(
          () => reportedProcessIds(transport).includes(taskId as string),
          "monitor start frame",
        );
        expect(transport.sent.map((frame) => JSON.parse(frame))).toContainEqual(
          expect.objectContaining({
            type: "update_device_status",
            device_status: expect.objectContaining({
              active_non_persistent_monitor_count: 1,
            }),
          }),
        );
      }
      transport.sent.length = 0;
      writeFileSync(releaseFile, "");
      await waitFor(
        () =>
          transport.sent.some(
            (frame) => JSON.parse(frame).type === "update_device_status",
          ),
        "completion device frame",
      );
      const frames = transport.sent.map((frame) => JSON.parse(frame));
      const queueIndex = frames.findIndex(
        (frame) => frame.type === "update_queue" && frame.queue.length === 1,
      );
      const deviceIndex = frames.findIndex(
        (frame) =>
          frame.type === "update_device_status" &&
          frame.device_status.background_processes.filter(
            (process: { kind: string }) => process.kind === kind,
          ).length === 0 &&
          (kind !== "monitor" ||
            frame.device_status.active_non_persistent_monitor_count === 0),
      );
      expect(queueIndex).toBeGreaterThanOrEqual(0);
      expect(deviceIndex).toBeGreaterThan(queueIndex);
    } finally {
      runtime.turnLifecycle.finish(lease, "end_turn");
      clearProcessServices(listener);
    }
  },
  15_000,
);

test.each([
  { persistent: true, count: 0 },
  { persistent: false, count: 1 },
])(
  "projects only finite monitors in the active count (%j) and clears on stop",
  async ({ persistent, count }) => {
    const { script } = writeWaitScript();
    const listener = createRuntime();
    setActiveRuntime(listener);
    const runtime = getOrCreateScopedRuntime(
      listener,
      AGENT_ID,
      CONVERSATION_ID,
    );
    const transport = new MockTransport();
    const connection = openListenerConnection({
      runtime: listener,
      connectionId: options.connectionId,
      writer: transport,
      options,
    });
    connection.initialized = true;
    subscribeListenerConnection(listener, options.connectionId, {
      agent_id: AGENT_ID,
      conversation_id: CONVERSATION_ID,
    });
    installProcessEventRouting({
      runtime: listener,
      processTransport: transport,
      opts: options,
      processQueuedTurn: async () => {},
    });
    try {
      const { taskId } = await monitor({
        command: `"${process.execPath}" "${script}"`,
        description: "wait",
        persistent,
        parentScope: scope,
      });
      await waitFor(
        () => reportedProcessIds(transport).includes(taskId),
        "monitor start frame",
      );
      expect(transport.sent.map((frame) => JSON.parse(frame))).toContainEqual(
        expect.objectContaining({
          type: "update_device_status",
          device_status: expect.objectContaining({
            active_non_persistent_monitor_count: count,
          }),
        }),
      );
      expect(listener.conversationRuntimes.has(runtime.key)).toBe(!persistent);
      expect(backgroundProcesses.get(taskId)?.status).toBe("running");
      expect(
        buildDeviceStatus(listener, {
          agent_id: AGENT_ID,
          conversation_id: "another-conversation",
        }).active_non_persistent_monitor_count,
      ).toBe(0);

      transport.sent.length = 0;
      expect(killBackgroundProcess(taskId)).toBe(true);
      await waitFor(
        () =>
          transport.sent.some((frame) => {
            const message = JSON.parse(frame);
            return (
              message.type === "update_device_status" &&
              message.device_status.active_non_persistent_monitor_count === 0 &&
              message.device_status.background_processes.length === 0
            );
          }),
        "monitor stop frame",
      );
      expect(listener.conversationRuntimes.has(runtime.key)).toBe(false);
    } finally {
      clearProcessServices(listener);
    }
  },
);

test("retiring a listener prevents its finite monitor from enqueueing in a replacement", async () => {
  const { script, releaseFile } = writeWaitScript();
  const previous = createRuntime();
  setActiveRuntime(previous);
  getOrCreateScopedRuntime(previous, AGENT_ID, CONVERSATION_ID);
  const taskId = await launchBackgroundWork("monitor", script);
  const process = backgroundProcesses.get(taskId as string);
  const completion = process?.completion;
  expect(completion).toBeDefined();

  stopRuntime(previous, true);
  const replacement = createRuntime();
  setActiveRuntime(replacement);
  const target = getOrCreateScopedRuntime(
    replacement,
    AGENT_ID,
    CONVERSATION_ID,
  );
  target.turnLifecycle.startCommand();
  installProcessEventRouting({
    runtime: replacement,
    processTransport: new MockTransport(),
    opts: options,
    processQueuedTurn: async () => {},
  });
  try {
    writeFileSync(releaseFile, "");
    await completion?.catch(() => {});
    expect(target.queueRuntime.length).toBe(0);
    expect(process?.status).toBe("failed");
  } finally {
    stopRuntime(replacement, true);
  }
}, 15_000);
