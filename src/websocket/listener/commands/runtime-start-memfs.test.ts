import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";
import { configureBackendMode } from "@/backend";
import { settingsManager } from "@/settings-manager";
import { openListenerConnection } from "@/websocket/listener/connection";
import { getOrCreateScopedRuntime } from "@/websocket/listener/conversation-runtime";
import { createRuntime } from "@/websocket/listener/lifecycle";
import { LocalListenerTransport } from "@/websocket/listener/transport";
import { handleMemfsSyncedMemoryProtocolCommand } from "./memory-command-sync";
import { handleRuntimeStartCommand } from "./runtime-start";

const originalHome = process.env.HOME;
const originalLocalBackendFlag = process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
let testHomeDir: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHomeDir = await mkdtemp(join(tmpdir(), "letta-runtime-start-home-"));
  process.env.HOME = testHomeDir;
  configureBackendMode("local");
  await settingsManager.initialize();
});

afterEach(async () => {
  await settingsManager.reset();
  configureBackendMode("api");
  if (originalLocalBackendFlag === undefined) {
    delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
  } else {
    process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackendFlag;
  }
  await rm(testHomeDir, { recursive: true, force: true });
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
});

function createSocketRecorder(): {
  socket: WebSocket;
  messages: string[];
} {
  const messages: string[] = [];
  return {
    socket: {
      readyState: 1,
      send: (data: string) => {
        messages.push(data);
      },
    } as unknown as WebSocket,
    messages,
  };
}

function createTaskRunner(): {
  runDetachedListenerTask: (
    _commandName: string,
    task: () => Promise<void>,
  ) => void;
  flush: () => Promise<void>;
} {
  const tasks: Promise<void>[] = [];
  return {
    runDetachedListenerTask: (
      _commandName: string,
      task: () => Promise<void>,
    ) => tasks.push(task()),
    flush: async () => {
      await Promise.all(tasks.splice(0));
    },
  };
}

describe("runtime_start memfs durability", () => {
  test("stateless create_agent memfs:false does not persist a settings row", async () => {
    const runtime = createRuntime();
    const connectionId = "connection-runtime-start";
    openListenerConnection({
      runtime,
      connectionId,
      writer: new LocalListenerTransport(),
      options: {
        connectionId,
        wsUrl: "ws://localhost",
        deviceId: "device-1",
        connectionName: "listener-test",
        onConnected: async () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });

    const { socket, messages } = createSocketRecorder();
    const result = await handleRuntimeStartCommand(
      {
        type: "runtime_start",
        request_id: "request-1",
        create_agent: {
          body: {
            name: "Worker agent",
            model: "anthropic/claude-sonnet-4-6",
          },
          memfs: false,
          pin_global: true,
        },
        create_conversation: {
          body: {
            summary: "Worker conversation",
          },
        },
      } as never,
      {
        connectionId,
        runtime,
        safeSocketSend: (_socket: WebSocket, payload: unknown) => {
          socket.send(JSON.stringify(payload));
          return true;
        },
        runDetachedListenerTask: (
          _commandName: string,
          task: () => Promise<void>,
        ) => {
          void task();
        },
        getOrCreateScopedRuntime,
        replaySyncStateForRuntime: async () => {},
        socket,
      } as never,
    );

    expect(result).toBe(true);
    const response = JSON.parse(messages.at(-1) ?? "{}") as {
      success?: boolean;
      agent?: { id?: string };
      created?: { agent?: boolean };
      error?: string;
    };
    if (!response.success) {
      throw new Error(response.error ?? JSON.stringify(response));
    }
    expect(response.created?.agent).toBe(true);
    expect(response.agent?.id).toBeDefined();
    expect(runtime.memfsDisabledAgents?.has(response.agent?.id ?? "")).toBe(
      true,
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await settingsManager.reset();
    await settingsManager.initialize();
    expect(settingsManager.getSettings().agents ?? []).toHaveLength(0);
  });

  test("runtime-disabled worker memory commands do not persist settings", async () => {
    const runtime = createRuntime();
    const connectionId = "connection-runtime-memory";
    openListenerConnection({
      runtime,
      connectionId,
      writer: new LocalListenerTransport(),
      options: {
        connectionId,
        wsUrl: "ws://localhost",
        deviceId: "device-1",
        connectionName: "listener-test",
        onConnected: async () => {},
        onDisconnected: () => {},
        onError: () => {},
      },
    });

    const { socket, messages } = createSocketRecorder();
    const taskRunner = createTaskRunner();
    const startResult = await handleRuntimeStartCommand(
      {
        type: "runtime_start",
        request_id: "request-2",
        create_agent: {
          body: {
            name: "Worker agent",
            model: "anthropic/claude-sonnet-4-6",
          },
          memfs: false,
          pin_global: true,
        },
        create_conversation: {
          body: {
            summary: "Worker conversation",
          },
        },
      } as never,
      {
        connectionId,
        runtime,
        safeSocketSend: (_socket: WebSocket, payload: unknown) => {
          socket.send(JSON.stringify(payload));
          return true;
        },
        runDetachedListenerTask: taskRunner.runDetachedListenerTask,
        getOrCreateScopedRuntime,
        replaySyncStateForRuntime: async () => {},
        socket,
      } as never,
    );

    expect(startResult).toBe(true);
    const startResponse = JSON.parse(messages.at(-1) ?? "{}") as {
      success?: boolean;
      agent?: { id?: string };
      error?: string;
    };
    if (!startResponse.success) {
      throw new Error(startResponse.error ?? JSON.stringify(startResponse));
    }
    const agentId = startResponse.agent?.id;
    expect(agentId).toBeDefined();
    expect(runtime.memfsDisabledAgents?.has(agentId ?? "")).toBe(true);

    const memoryCommands = [
      {
        type: "list_memory",
        request_id: "request-list",
        agent_id: agentId,
      },
      {
        type: "read_memory_file",
        request_id: "request-read",
        agent_id: agentId,
        path: "notes.md",
      },
      {
        type: "write_memory_file",
        request_id: "request-write",
        agent_id: agentId,
        path: "notes.md",
        content: "hello",
      },
      {
        type: "delete_memory_file",
        request_id: "request-delete",
        agent_id: agentId,
        path: "notes.md",
      },
    ] as const;

    for (const command of memoryCommands) {
      const handled = handleMemfsSyncedMemoryProtocolCommand(command, {
        socket,
        runtime,
        safeSocketSend: (_socket: WebSocket, payload: unknown) => {
          socket.send(JSON.stringify(payload));
          return true;
        },
        runDetachedListenerTask: taskRunner.runDetachedListenerTask,
      });
      expect(handled).toBe(true);
      await taskRunner.flush();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settingsManager.getSettings().agents ?? []).toHaveLength(0);
    }

    await settingsManager.reset();
    await settingsManager.initialize();
    expect(settingsManager.getSettings().agents ?? []).toHaveLength(0);
  });
});
