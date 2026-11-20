import { afterEach, expect, test } from "bun:test";
import type WebSocket from "ws";
import { MANAGED_CLOUD_RUNTIME_ENV } from "@/managed-cloud-runtime";
import {
  isSandboxDiskWatchRunning,
  resetDiskSpaceAlertForTests,
} from "@/reminders/disk-space";
import {
  addToMessageQueue,
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { resolveNotificationScope } from "@/utils/task-notifications";
import { handleTaskControlCommand } from "./commands/task-control";
import { openListenerConnection } from "./connection";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  deliverSandboxDiskAlert,
  installProcessEventRouting,
} from "./process-services";
import {
  evictConversationRuntimeIfIdle,
  getActiveRuntime,
  getConversationRuntime,
  getOrCreateConversationRuntime,
  setActiveRuntime,
} from "./runtime";
import { LocalListenerTransport } from "./transport";

const originalManaged = process.env[MANAGED_CLOUD_RUNTIME_ENV];

afterEach(() => {
  if (originalManaged === undefined)
    delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
  else process.env[MANAGED_CLOUD_RUNTIME_ENV] = originalManaged;
  resetDiskSpaceAlertForTests();
});

function startProcessServices() {
  const listener = createRuntime();
  installProcessEventRouting({
    runtime: listener,
    processTransport: new LocalListenerTransport(),
    opts: {
      connectionId: "conn-disk",
      wsUrl: "ws://test",
      deviceId: "device-disk",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    },
    processQueuedTurn: async () => {},
  });
  return listener;
}

test("a Cloud listener watches the sandbox disk until shutdown", () => {
  process.env[MANAGED_CLOUD_RUNTIME_ENV] = "1";
  const listener = startProcessServices();
  expect(isSandboxDiskWatchRunning()).toBe(true);
  clearProcessServices(listener);
  expect(isSandboxDiskWatchRunning()).toBe(false);
});

test("a listener outside Cloud starts no disk watcher", () => {
  delete process.env[MANAGED_CLOUD_RUNTIME_ENV];
  const listener = startProcessServices();
  try {
    expect(isSandboxDiskWatchRunning()).toBe(false);
  } finally {
    clearProcessServices(listener);
  }
});

function captureQueuedAlerts(): QueuedMessage[] {
  const queued: QueuedMessage[] = [];
  setMessageQueueAdder((message) => queued.push(message));
  return queued;
}

test("the disk alert goes only to the most recently active conversation", () => {
  const listener = startProcessServices();
  try {
    const recent = getOrCreateConversationRuntime(
      listener,
      "agent-a",
      "conv-a",
    );
    const idle = getOrCreateConversationRuntime(listener, "agent-b", "conv-b");
    recent.contextTracker.contextTokensHistory.push({
      timestamp: 2_000,
      tokens: 1,
      turnId: 1,
    });
    idle.contextTracker.contextTokensHistory.push({
      timestamp: 1_000,
      tokens: 1,
      turnId: 1,
    });
    const queued = captureQueuedAlerts();
    deliverSandboxDiskAlert(listener, "LOW DISK SPACE");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.agentId).toBe("agent-a");
    expect(queued[0]?.conversationId).toBe("conv-a");
  } finally {
    clearProcessServices(listener);
  }
});

test("with no conversation the disk alert falls back to the default scope", () => {
  const listener = startProcessServices();
  try {
    const queued = captureQueuedAlerts();
    deliverSandboxDiskAlert(listener, "LOW DISK SPACE");
    expect(queued).toHaveLength(1);
    const fallback = resolveNotificationScope();
    expect(queued[0]?.agentId).toBe(fallback?.agentId);
    expect(queued[0]?.conversationId).toBe(fallback?.conversationId);
  } finally {
    clearProcessServices(listener);
  }
});

test("a remote caller's sideband launch scope cannot receive local turn notifications", async () => {
  const listener = startProcessServices();
  const previousRuntime = getActiveRuntime();
  setActiveRuntime(listener);
  const socket = new LocalListenerTransport() as unknown as WebSocket;
  const opts = {
    connectionId: "conn-worker",
    wsUrl: "ws://test",
    deviceId: "device-worker",
    connectionName: "worker",
    onConnected() {},
    onDisconnected() {},
    onError() {},
  };
  // The real command handler creates the scope before checking cancellation.
  // Cancel startup so the test needs no external worker process.
  const cancellation = new AbortController();
  cancellation.abort();
  openListenerConnection({
    runtime: listener,
    connectionId: opts.connectionId,
    writer: socket,
    cancellation,
    options: opts,
  });
  const agentId = "agent-caller";
  const conversationId = "conv-caller";
  try {
    const tasks: Promise<void>[] = [];
    await handleTaskControlCommand(
      {
        type: "launch_subagent",
        request_id: "launch-worker",
        runtime: { agent_id: agentId, conversation_id: conversationId },
        args: {
          subagent_type: "claude-code",
          description: "Status check",
          prompt: "Check status",
        },
        notify: "caller",
      },
      {
        runtime: listener,
        socket,
        connectionId: opts.connectionId,
        getOrCreateScopedRuntime,
        runDetachedListenerTask: (_name, task) => tasks.push(task()),
        safeSocketSend: () => true,
      },
    );
    await Promise.all(tasks);
    const parent = getConversationRuntime(listener, agentId, conversationId);
    if (!parent) throw new Error("The launch did not create its parent scope");

    deliverSandboxDiskAlert(listener, "LOW DISK SPACE");
    expect(parent.queueRuntime.length).toBe(0);
    expect(parent.queuePumpScheduled).toBe(false);

    addToMessageQueue({
      kind: "task_notification",
      text: "A background task finished",
      agentId,
      conversationId,
    });
    expect(parent.queueRuntime.length).toBe(0);
    expect(parent.queuePumpScheduled).toBe(false);

    const local = getOrCreateScopedRuntime(
      listener,
      "agent-local",
      "conv-local",
    );
    deliverSandboxDiskAlert(listener, "LOW DISK SPACE");
    expect(local.queueRuntime.length).toBe(1);
    expect(local.queuePumpScheduled).toBe(true);
    expect(parent.queueRuntime.length).toBe(0);
    await local.messageQueue;

    expect(evictConversationRuntimeIfIdle(parent)).toBe(true);
    const notification = {
      kind: "task_notification",
      text: "A background task finished",
      agentId,
      conversationId,
    } as const;
    addToMessageQueue(notification);
    expect(
      getConversationRuntime(listener, agentId, conversationId),
    ).toBeNull();

    const resumed = getOrCreateScopedRuntime(listener, agentId, conversationId);
    expect(
      enqueueInboundUserMessage(resumed, {
        type: "message",
        agentId,
        conversationId,
        messages: [{ role: "user", content: "Continue here" }],
      }),
    ).toBe(true);
    addToMessageQueue(notification);
    expect(resumed.queueRuntime.length).toBe(2);
    await resumed.messageQueue;
  } finally {
    clearProcessServices(listener);
    setActiveRuntime(previousRuntime);
  }
});
