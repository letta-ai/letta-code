import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";
import { createRuntime, stopRuntime } from "@/websocket/listener/lifecycle";
import {
  getActiveRuntime,
  setActiveRuntime,
} from "@/websocket/listener/runtime";

const ORIGINAL_DISABLE_MODS = process.env.LETTA_DISABLE_MODS;
const ORIGINAL_DISABLE_CRON = process.env.LETTA_DISABLE_CRON_SCHEDULER;

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve) => socket.once("close", () => resolve()));
}

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket message")),
      10_000,
    );
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as Record<string, unknown>;
      if (!predicate(message)) return;
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

function closeClient(socket: WebSocket | null): void {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

beforeEach(() => {
  process.env.LETTA_DISABLE_MODS = "1";
  process.env.LETTA_DISABLE_CRON_SCHEDULER = "1";
});

afterEach(() => {
  __testSetBackend(null);
  const active = getActiveRuntime();
  if (active) {
    stopRuntime(active, true);
    setActiveRuntime(null);
  }
  if (ORIGINAL_DISABLE_MODS === undefined) {
    delete process.env.LETTA_DISABLE_MODS;
  } else {
    process.env.LETTA_DISABLE_MODS = ORIGINAL_DISABLE_MODS;
  }
  if (ORIGINAL_DISABLE_CRON === undefined) {
    delete process.env.LETTA_DISABLE_CRON_SCHEDULER;
  } else {
    process.env.LETTA_DISABLE_CRON_SCHEDULER = ORIGINAL_DISABLE_CRON;
  }
});

describe("app-server startup lifecycle", () => {
  test("a shared-runtime bind failure leaves the listener runtime usable", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const port = (occupied.address() as AddressInfo).port;
    const runtime = createRuntime();
    runtime.connectionId = "outbound-listener";
    runtime.connectionName = "primary listener";
    const onWsEvent = mock(() => {});
    runtime.onWsEvent = onWsEvent;
    setActiveRuntime(runtime);

    try {
      await expect(
        startAppServer({
          listen: `ws://127.0.0.1:${port}`,
          runtime,
        }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(getActiveRuntime()).toBe(runtime);
      expect(runtime.intentionallyClosed).toBe(false);
      expect(runtime.connectionId).toBe("outbound-listener");
      expect(runtime.connectionName).toBe("primary listener");
      expect(runtime.onWsEvent).toBe(onWsEvent);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  test("a shared App Server preserves and does not own the listener runtime", async () => {
    const runtime = createRuntime();
    runtime.connectionId = "outbound-listener";
    runtime.connectionName = "primary listener";
    const onWsEvent = mock(() => {});
    runtime.onWsEvent = onWsEvent;
    setActiveRuntime(runtime);
    const handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      runtime,
      connectionName: "channel loopback",
    });
    const client = new WebSocket(handle.controlUrl);
    await waitForOpen(client);
    await waitFor(
      () => runtime.connections.size === 1,
      "shared App Server connection was not attached to listener runtime",
    );

    expect(getActiveRuntime()).toBe(runtime);
    expect([...runtime.connections.keys()][0]).toMatch(/^app-server-/);
    expect(runtime.connectionId).toBe("outbound-listener");
    expect(runtime.connectionName).toBe("primary listener");
    expect(runtime.onWsEvent).toBe(onWsEvent);

    closeClient(client);
    await handle.close();

    expect(getActiveRuntime()).toBe(runtime);
    expect(runtime.intentionallyClosed).toBe(false);
  });

  test("an attached controller can leave process services to the primary listener", async () => {
    const runtime = createRuntime();
    runtime.connectionId = "outbound-listener";
    runtime.connectionName = "primary listener";
    setActiveRuntime(runtime);
    const handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      runtime,
      connectionName: "channel loopback",
      startProcessServices: false,
    });
    const client = new WebSocket(handle.controlUrl);

    try {
      await waitForOpen(client);
      await waitFor(
        () => runtime.connections.size === 1,
        "controller connection was not attached to listener runtime",
      );
      expect(runtime.processServicesStarted).toBe(false);
    } finally {
      closeClient(client);
      await handle.close();
    }
  });

  test("a bind failure preserves the active runtime and a later start succeeds", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) =>
      occupied.listen(0, "127.0.0.1", resolve),
    );
    const port = (occupied.address() as AddressInfo).port;
    const existingRuntime = createRuntime();
    setActiveRuntime(existingRuntime);
    let handle: AppServerHandle | null = null;

    try {
      await expect(
        startAppServer({ listen: `ws://127.0.0.1:${port}` }),
      ).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(getActiveRuntime()).toBe(existingRuntime);
      expect(existingRuntime.intentionallyClosed).toBe(false);

      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
      handle = await startAppServer({
        listen: `ws://127.0.0.1:${port}`,
      });

      expect(getActiveRuntime()).not.toBe(existingRuntime);
      expect(existingRuntime.intentionallyClosed).toBe(true);
    } finally {
      await handle?.close();
      if (occupied.listening) {
        await new Promise<void>((resolve) => occupied.close(() => resolve()));
      }
    }
  });

  test("a rejected runtime initializer is retried by the next connection", async () => {
    const initializeRuntime = mock(async () => {
      if (initializeRuntime.mock.calls.length === 1) {
        throw new Error("transient startup failure");
      }
    });
    const handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      initializeRuntime,
    });
    let first: WebSocket | null = null;
    let second: WebSocket | null = null;

    try {
      first = new WebSocket(handle.controlUrl);
      await waitForClose(first);

      second = new WebSocket(handle.controlUrl);
      await waitForOpen(second);
      const response = waitForJsonMessage(
        second,
        (message) =>
          message.type === "app_server_info_response" &&
          message.request_id === "retry-ready",
      );
      second.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "retry-ready",
        }),
      );
      await response;

      expect(initializeRuntime).toHaveBeenCalledTimes(2);
    } finally {
      closeClient(first);
      closeClient(second);
      await handle.close();
    }
  });

  test("commands received before initialization are dropped after disconnect", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "letta-init-cancel-"));
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    __testSetBackend(backend);
    let resolveInitialization: (() => void) | undefined;
    const initialization = new Promise<void>((resolve) => {
      resolveInitialization = resolve;
    });
    const handle = await startAppServer({
      listen: "ws://127.0.0.1:0",
      initializeRuntime: () => initialization,
    });
    let client: WebSocket | null = null;

    try {
      client = new WebSocket(handle.controlUrl);
      await waitForOpen(client);
      client.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "disconnected-start",
          create_agent: {
            body: {
              name: "Must Not Be Created",
              model: "anthropic/claude-sonnet-4-6",
            } as AgentCreateBody,
            pin_global: false,
          },
          create_conversation: {
            body: { summary: "Disconnected initialization" },
          },
          recover_approvals: false,
        }),
      );
      const closed = waitForClose(client);
      client.close();
      await closed;
      await waitFor(
        () => getActiveRuntime()?.connections.size === 0,
        "server did not remove disconnected client",
      );
      resolveInitialization?.();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const agents = (await backend.listAgents({
        limit: 10,
      } as never)) as unknown as { items: unknown[] };
      expect(agents.items).toEqual([]);
      expect(getActiveRuntime()?.connections.size).toBe(0);
    } finally {
      resolveInitialization?.();
      closeClient(client);
      await handle.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
