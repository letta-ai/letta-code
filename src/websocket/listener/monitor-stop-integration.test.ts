import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type Backend } from "@/backend";
import { LocalStore } from "@/backend/local/local-store";
import { settingsManager } from "@/settings-manager";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { createListenerMessageHandler } from "./message-router";
import {
  clearMonitorCancellationDelivery,
  getMonitorCancellationServices,
  installMonitorCancellationDelivery,
  wasCancellationInputPersisted,
} from "./monitor-cancellation-delivery";
import { setActiveRuntime } from "./runtime";
import type { IncomingMessage, StartListenerOptions } from "./types";

const previousHome = process.env.LETTA_HOME;
const directories: string[] = [];
afterEach(() => {
  __testSetBackend(null);
  setActiveRuntime(null);
  if (previousHome === undefined) delete process.env.LETTA_HOME;
  else process.env.LETTA_HOME = previousHome;
  for (const id of backgroundProcesses.keys())
    clearBackgroundProcessCleanup(id);
  backgroundProcesses.clear();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

for (const busy of [false, true])
  test(`wire cancellation persists and delivers the relay actor while ${busy ? "busy" : "idle"}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "monitor-wire-"));
    directories.push(directory);
    process.env.LETTA_HOME = directory;
    await settingsManager.initialize();
    const local = new LocalStore("agent-a", {
      storageDir: join(directory, "backend"),
    });
    const backend = {
      listConversationMessages: async (id: string, query: never) =>
        local.listConversationMessages(id, query),
    };
    __testSetBackend(backend as unknown as Backend);
    const listener = createRuntime();
    setActiveRuntime(listener);
    const target = getOrCreateScopedRuntime(listener, "agent-a", "default");
    if (busy) target.turnLifecycle.startCommand();
    const sent: unknown[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (text: string) => sent.push(JSON.parse(text)),
    } as unknown as WebSocket;
    const opts: StartListenerOptions = {
      connectionId: "connection-a",
      wsUrl: "wss://example.test/ws",
      deviceId: "device-a",
      connectionName: "test",
      onConnected() {},
      onDisconnected() {},
      onError() {},
    };
    const delivered: IncomingMessage[] = [];
    const processQueuedTurn = async (incoming: IncomingMessage) => {
      delivered.push(incoming);
      local.appendTurnInput("default", {
        agent_id: "agent-a",
        messages: incoming.messages,
      } as never);
    };
    const cleanup = installMonitorCancellationDelivery({
      runtime: listener,
      processTransport: socket,
      opts,
      processQueuedTurn,
    });
    backgroundProcesses.set("monitor-wire", {
      kind: "monitor",
      description: "CI results",
      command: "wait",
      process: { kill() {} },
      status: "running",
      exitCode: null,
      runtimeScope: { agentId: "agent-a", conversationId: "default" },
      stdout: [],
      stderr: [],
      lastReadIndex: { stdout: 0, stderr: 0 },
    });
    const handler = createListenerMessageHandler({
      runtime: listener,
      socket,
      opts,
      processQueuedTurn,
      fileCommandSession: { handle: () => false },
      getParsedRuntimeScope: () => null,
      replaySyncStateForRuntime: async () => {},
      getOrCreateScopedRuntime: () => target,
      handleApprovalResponseInput: async () => false,
      handleChangeDeviceStateInput: async () => false,
      handleAbortMessageInput: async () => false,
      stampInboundUserMessageOtids: (input) => input,
      safeSocketSend: (_socket, payload) => {
        sent.push(payload);
        return true;
      },
      runDetachedListenerTask() {},
      trackListenerError() {},
    });
    try {
      const command = {
        type: "monitor_stop",
        request_id: "stop-1",
        process_id: "monitor-wire",
        runtime: {
          agent_id: "agent-a",
          conversation_id: "default",
          acting_user_id: "human-a",
        },
      };
      await handler(Buffer.from(JSON.stringify(command)));
      expect(sent).toContainEqual({
        ...command,
        type: "monitor_stop_response",
        success: true,
        stopped: true,
      });
      const receipt =
        getMonitorCancellationServices().store.read("monitor-wire");
      expect(receipt?.runtime.acting_user_id).toBe("human-a");
      for (
        let i = 0;
        i < 100 && target.queueRuntime.length === 0 && delivered.length === 0;
        i++
      )
        await Bun.sleep(2);
      if (busy) {
        expect(delivered).toHaveLength(0);
        expect(target.queueRuntime.length).toBe(1);
        target.turnLifecycle.finishCommand();
        const { scheduleQueuePump } = await import("./queue");
        scheduleQueuePump(target, socket, opts, processQueuedTurn);
      }
      for (let i = 0; i < 100 && delivered.length === 0; i++)
        await Bun.sleep(2);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]?.actingUserId).toBe("human-a");
      expect(receipt && (await wasCancellationInputPersisted(receipt))).toBe(
        true,
      );
      await handler(
        Buffer.from(JSON.stringify({ ...command, request_id: "stop-2" })),
      );
      expect(sent).toContainEqual({
        ...command,
        type: "monitor_stop_response",
        request_id: "stop-2",
        success: true,
        stopped: false,
      });
      expect(delivered).toHaveLength(1);
    } finally {
      cleanup();
      clearMonitorCancellationDelivery(listener);
    }
  });
