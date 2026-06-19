import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AgentCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  type AppServerHandle,
  parseAppServerListenUrl,
  parseAppServerPublicUrl,
  startAppServer,
} from "@/websocket/app-server";

const TEST_TIMEOUT_MS = 5000;

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for websocket open"));
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", handleOpen);
      socket.off("error", handleError);
    };
    const handleOpen = () => {
      cleanup();
      resolve();
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("open", handleOpen);
    socket.once("error", handleError);
  });
}

function waitForJsonMessage(
  socket: WebSocket,
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const seen: Record<string, unknown>[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for websocket message; saw ${JSON.stringify(seen)}`,
        ),
      );
    }, TEST_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", handleMessage);
      socket.off("error", handleError);
    };
    const handleMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(String(raw)) as Record<string, unknown>;
      seen.push(parsed);
      if (!predicate(parsed)) {
        return;
      }
      cleanup();
      resolve(parsed);
    };
    const handleError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.on("message", handleMessage);
    socket.once("error", handleError);
  });
}

function closeClient(socket: WebSocket | null): void {
  if (!socket) return;
  if (
    socket.readyState === WebSocket.OPEN ||
    socket.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

afterEach(() => {
  __testSetBackend(null);
});

describe("app-server native websocket", () => {
  test("parses loopback websocket listen URLs", () => {
    expect(parseAppServerListenUrl()).toEqual({
      host: "127.0.0.1",
      port: 0,
      path: "/ws",
      public: false,
    });
    expect(parseAppServerListenUrl("ws://localhost:4500/custom")).toEqual({
      host: "localhost",
      port: 4500,
      path: "/custom",
      public: false,
    });
    expect(() => parseAppServerListenUrl("stdio://")).toThrow(
      /only supports ws:\/\//,
    );
    expect(() => parseAppServerListenUrl("ws://0.0.0.0:4500")).toThrow(
      /auth token/,
    );
    expect(
      parseAppServerListenUrl("ws://0.0.0.0:4500", { allowPublic: true }),
    ).toEqual({
      host: "0.0.0.0",
      port: 4500,
      path: "/ws",
      public: true,
    });
  });

  test("parses public app-server URLs for advertised client endpoints", () => {
    expect(parseAppServerPublicUrl("wss://example.com", "/ws")).toEqual({
      baseUrl: "wss://example.com",
      path: "/ws",
    });
    expect(parseAppServerPublicUrl("wss://example.com/custom", "/ws")).toEqual({
      baseUrl: "wss://example.com",
      path: "/custom",
    });
    expect(() => parseAppServerPublicUrl("https://example.com")).toThrow(
      /must use ws:\/\/ or wss:\/\//,
    );
    expect(() => parseAppServerPublicUrl("wss://example.com?x=1")).toThrow(
      /cannot include auth, query, or hash/,
    );
  });

  test("serves health probes", async () => {
    let handle: AppServerHandle | null = null;
    try {
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      const httpUrl = handle.url.replace(/^ws:/, "http:");

      const ready = await fetch(`${httpUrl}/readyz`);
      expect(ready.status).toBe(200);
      expect(await ready.text()).toBe("ok\n");

      const health = await fetch(`${httpUrl}/healthz`);
      expect(health.status).toBe(200);

      const browserHealth = await fetch(`${httpUrl}/healthz`, {
        headers: { Origin: "https://example.com" },
      });
      expect(browserHealth.status).toBe(403);
    } finally {
      await handle?.close();
    }
  });

  test("requires auth token for websocket upgrades when configured", async () => {
    let handle: AppServerHandle | null = null;
    let rejected: WebSocket | null = null;
    let accepted: WebSocket | null = null;
    try {
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        authToken: "test-token",
      });

      rejected = new WebSocket(handle.controlUrl);
      await expect(waitForOpen(rejected)).rejects.toThrow();

      const acceptedUrl = new URL(handle.controlUrl);
      acceptedUrl.searchParams.set("token", "test-token");
      accepted = new WebSocket(acceptedUrl);
      await waitForOpen(accepted);
    } finally {
      closeClient(rejected);
      closeClient(accepted);
      await handle?.close();
    }
  });

  test("allows public listen URLs when auth is configured", async () => {
    let handle: AppServerHandle | null = null;
    try {
      handle = await startAppServer({
        listen: "ws://0.0.0.0:0",
        authToken: "test-token",
        publicUrl: "wss://example.up.railway.app",
      });

      expect(handle.url).toBe("wss://example.up.railway.app");
      expect(handle.controlUrl).toBe(
        "wss://example.up.railway.app/ws?channel=control",
      );
      expect(handle.streamUrl).toBe(
        "wss://example.up.railway.app/ws?channel=stream",
      );
    } finally {
      await handle?.close();
    }
  });

  test("starts a runtime over control and emits state frames over stream", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "letta-app-server-"));
    let handle: AppServerHandle | null = null;
    let control: WebSocket | null = null;
    let stream: WebSocket | null = null;
    try {
      __testSetBackend(
        new LocalBackend({ storageDir, executionMode: "deterministic" }),
      );
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      stream = new WebSocket(handle.streamUrl);
      control = new WebSocket(handle.controlUrl);
      await Promise.all([waitForOpen(stream), waitForOpen(control)]);

      control.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "runtime-start-1",
          create_agent: {
            body: {
              name: "App Server Agent",
              model: "anthropic/claude-sonnet-4-6",
            } as AgentCreateBody,
            pin_global: false,
          },
          create_conversation: {
            body: { summary: "App server conversation" },
          },
          recover_approvals: false,
        }),
      );

      const startResponse = await waitForJsonMessage(
        control,
        (message) => message.type === "runtime_start_response",
      );
      expect(startResponse).toMatchObject({
        type: "runtime_start_response",
        request_id: "runtime-start-1",
        success: true,
        created: { agent: true, conversation: true },
      });
      const runtime = startResponse.runtime as {
        agent_id: string;
        conversation_id: string;
      };

      await waitForJsonMessage(
        stream,
        (message) =>
          message.type === "update_device_status" &&
          JSON.stringify(message.runtime) === JSON.stringify(runtime),
      );

      const loopStatus = await waitForJsonMessage(stream, (message) => {
        const loopStatus = message.loop_status as
          | { status?: unknown }
          | undefined;
        return (
          message.type === "update_loop_status" &&
          loopStatus?.status === "WAITING_ON_INPUT" &&
          JSON.stringify(message.runtime) === JSON.stringify(runtime)
        );
      });

      expect(loopStatus).toMatchObject({
        type: "update_loop_status",
        runtime,
        loop_status: { status: "WAITING_ON_INPUT" },
      });
    } finally {
      closeClient(control);
      closeClient(stream);
      await handle?.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
