import { afterEach, expect, test } from "bun:test";
import { MANAGED_CLOUD_RUNTIME_ENV } from "@/managed-cloud-runtime";
import {
  isSandboxDiskWatchRunning,
  resetDiskSpaceAlertForTests,
} from "@/reminders/disk-space";
import {
  type QueuedMessage,
  setMessageQueueAdder,
} from "@/utils/message-queue-bridge";
import { resolveNotificationScope } from "@/utils/task-notifications";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  deliverSandboxDiskAlert,
  installProcessEventRouting,
} from "./process-services";
import { getOrCreateConversationRuntime } from "./runtime";
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
