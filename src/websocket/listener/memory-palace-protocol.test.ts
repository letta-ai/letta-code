import { describe, expect, test } from "bun:test";
import WebSocket from "ws";
import type { Settings } from "@/settings-manager";
import { settingsManager } from "@/settings-manager";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { handleExperimentCommand } from "@/websocket/listener/commands/settings";
import type { SafeSocketSend } from "@/websocket/listener/commands/types";
import { isSetExperimentCommand } from "@/websocket/listener/protocol-inbound";
import type { ListenerRuntime } from "@/websocket/listener/types";

setupRuntimeModelCatalogFixture();

class MockSocket {
  readyState: number = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }

  close(): void {
    // no-op for tests
  }

  removeAllListeners(): this {
    return this;
  }
}

const safeSocketSend: SafeSocketSend = (socket, payload) => {
  (socket as unknown as MockSocket).sentPayloads.push(JSON.stringify(payload));
  return true;
};

describe("memory_palace listener protocol pathway", () => {
  test("set_experiment inbound validation accepts memory_palace", () => {
    expect(
      isSetExperimentCommand({
        type: "set_experiment",
        request_id: "palace-validate-1",
        experiment_id: "memory_palace",
        enabled: true,
      }),
    ).toBe(true);
  });

  test("set_experiment inbound validation still rejects unknown experiment ids", () => {
    expect(
      isSetExperimentCommand({
        type: "set_experiment",
        request_id: "palace-validate-2",
        experiment_id: "not_a_real_experiment",
        enabled: true,
      }),
    ).toBe(false);
  });

  test("get_experiments lists memory_palace as disabled by default", async () => {
    const socket = new MockSocket();
    const listener: ListenerRuntime =
      __listenClientTestUtils.createListenerRuntime();
    __listenClientTestUtils.getOrCreateConversationRuntime(
      listener,
      "agent-palace-1",
      "default",
    );

    await handleExperimentCommand(
      { type: "get_experiments", request_id: "palace-get-1" },
      socket as unknown as WebSocket,
      listener,
      safeSocketSend,
    );

    const response = JSON.parse(socket.sentPayloads[0] as string);
    expect(response).toMatchObject({
      type: "get_experiments_response",
      request_id: "palace-get-1",
      success: true,
      experiments: expect.arrayContaining([
        expect.objectContaining({
          id: "memory_palace",
          enabled: false,
          source: "default",
        }),
      ]),
    });
  });

  test("set_experiment toggles memory_palace and projects it into device status", async () => {
    // Object-level stubs (not mock.module) so experiment overrides never touch
    // the real user settings file, mirroring listen-client-protocol.test.ts.
    const originalGetSettings = settingsManager.getSettings;
    const originalUpdateSettings = settingsManager.updateSettings;
    const globalSettings = { autoConversationTitles: false } as Settings;

    try {
      settingsManager.getSettings = (() =>
        globalSettings) as typeof settingsManager.getSettings;
      settingsManager.updateSettings = ((updates: Record<string, unknown>) => {
        Object.assign(
          globalSettings as unknown as Record<string, unknown>,
          updates,
        );
      }) as typeof settingsManager.updateSettings;

      const socket = new MockSocket();
      const listener: ListenerRuntime =
        __listenClientTestUtils.createListenerRuntime();
      __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        "agent-palace-2",
        "default",
      );

      await handleExperimentCommand(
        {
          type: "set_experiment",
          request_id: "palace-set-1",
          experiment_id: "memory_palace",
          enabled: true,
        },
        socket as unknown as WebSocket,
        listener,
        safeSocketSend,
      );

      const setResponse = JSON.parse(socket.sentPayloads[0] as string);
      const deviceStatusUpdate = JSON.parse(socket.sentPayloads[1] as string);
      expect(setResponse).toMatchObject({
        type: "set_experiment_response",
        request_id: "palace-set-1",
        success: true,
        experiments: expect.arrayContaining([
          expect.objectContaining({
            id: "memory_palace",
            enabled: true,
            source: "override",
          }),
        ]),
      });
      expect(deviceStatusUpdate).toMatchObject({
        type: "update_device_status",
        device_status: {
          experiments: expect.arrayContaining([
            expect.objectContaining({
              id: "memory_palace",
              enabled: true,
              source: "override",
            }),
          ]),
        },
      });
    } finally {
      settingsManager.getSettings = originalGetSettings;
      settingsManager.updateSettings = originalUpdateSettings;
    }
  });
});
