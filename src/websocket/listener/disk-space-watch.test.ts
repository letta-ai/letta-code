import { afterEach, expect, test } from "bun:test";
import { MANAGED_CLOUD_RUNTIME_ENV } from "@/managed-cloud-runtime";
import {
  isSandboxDiskWatchRunning,
  resetDiskSpaceAlertForTests,
} from "@/reminders/disk-space";
import { createRuntime } from "./lifecycle";
import {
  clearProcessServices,
  installProcessEventRouting,
} from "./process-services";
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
