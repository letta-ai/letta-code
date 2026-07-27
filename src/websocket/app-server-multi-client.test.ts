import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AgentCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";

const TEST_TIMEOUT_MS = 10_000;

function waitForOpen(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket open")),
      TEST_TIMEOUT_MS,
    );
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for websocket close")),
      TEST_TIMEOUT_MS,
    );
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

function collectMessages(socket: WebSocket): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  socket.on("message", (raw) => {
    messages.push(JSON.parse(String(raw)) as Record<string, unknown>);
  });
  return messages;
}

async function waitForMessage(
  messages: Record<string, unknown>[],
  predicate: (message: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < TEST_TIMEOUT_MS) {
    const match = messages.find(predicate);
    if (match) return match;
    await Bun.sleep(1);
  }
  throw new Error(
    `Timed out waiting for app-server message; saw ${JSON.stringify(messages)}`,
  );
}

function closeClient(socket: WebSocket | null): void {
  if (
    socket?.readyState === WebSocket.OPEN ||
    socket?.readyState === WebSocket.CONNECTING
  ) {
    socket.close();
  }
}

function runtimeStartCommand(name: string): Record<string, unknown> {
  return {
    type: "runtime_start",
    request_id: "shared-request-id",
    create_agent: {
      body: {
        name,
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody,
      pin_global: false,
    },
    create_conversation: { body: { summary: `${name} conversation` } },
    recover_approvals: false,
  };
}

afterEach(() => {
  __testSetBackend(null);
});

describe("app-server multi-client isolation", () => {
  test("keeps concurrent runtimes, request IDs, routing, and disconnect cleanup isolated", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "letta-app-server-multi-"),
    );
    let handle: AppServerHandle | null = null;
    let clientA: WebSocket | null = null;
    let clientB: WebSocket | null = null;
    try {
      __testSetBackend(
        new LocalBackend({ storageDir, executionMode: "deterministic" }),
      );
      handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
      clientA = new WebSocket(handle.duplexUrl);
      clientB = new WebSocket(handle.duplexUrl);
      const messagesA = collectMessages(clientA);
      const messagesB = collectMessages(clientB);
      await Promise.all([waitForOpen(clientA), waitForOpen(clientB)]);

      clientA.send(JSON.stringify(runtimeStartCommand("Client A")));
      clientB.send(JSON.stringify(runtimeStartCommand("Client B")));
      const [responseA, responseB] = await Promise.all([
        waitForMessage(
          messagesA,
          (message) => message.type === "runtime_start_response",
        ),
        waitForMessage(
          messagesB,
          (message) => message.type === "runtime_start_response",
        ),
      ]);
      expect(responseA).toMatchObject({
        request_id: "shared-request-id",
        success: true,
        agent: { name: "Client A" },
      });
      expect(responseB).toMatchObject({
        request_id: "shared-request-id",
        success: true,
        agent: { name: "Client B" },
      });
      const runtimeA = responseA.runtime as {
        agent_id: string;
        conversation_id: string;
      };
      const runtimeB = responseB.runtime as {
        agent_id: string;
        conversation_id: string;
      };
      expect(runtimeA).not.toEqual(runtimeB);

      await Promise.all([
        waitForMessage(
          messagesA,
          (message) =>
            message.type === "update_loop_status" &&
            JSON.stringify(message.runtime) === JSON.stringify(runtimeA),
        ),
        waitForMessage(
          messagesB,
          (message) =>
            message.type === "update_loop_status" &&
            JSON.stringify(message.runtime) === JSON.stringify(runtimeB),
        ),
      ]);
      expect(
        messagesA.some(
          (message) =>
            JSON.stringify(message.runtime) === JSON.stringify(runtimeB),
        ),
      ).toBe(false);
      expect(
        messagesB.some(
          (message) =>
            JSON.stringify(message.runtime) === JSON.stringify(runtimeA),
        ),
      ).toBe(false);

      clientB.send(
        JSON.stringify({
          type: "runtime_start",
          request_id: "conflicting-owner",
          agent_id: runtimeA.agent_id,
          conversation_id: runtimeA.conversation_id,
          recover_approvals: false,
        }),
      );
      expect(
        await waitForMessage(
          messagesB,
          (message) => message.request_id === "conflicting-owner",
        ),
      ).toMatchObject({
        type: "runtime_start_response",
        success: false,
        error: expect.stringContaining("already owned"),
      });

      const infoPromise = waitForMessage(
        messagesB,
        (message) => message.request_id === "management-during-turn",
      );
      clientA.send(
        JSON.stringify({
          type: "input",
          runtime: runtimeA,
          payload: {
            kind: "create_message",
            messages: [{ role: "user", content: "Say hello briefly." }],
          },
        }),
      );
      clientB.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "management-during-turn",
        }),
      );
      await expect(infoPromise).resolves.toMatchObject({
        type: "app_server_info_response",
        success: true,
      });

      clientA.terminate();
      await waitForClose(clientA);
      const syncPromise = waitForMessage(
        messagesB,
        (message) => message.request_id === "sync-after-a-disconnect",
      );
      clientB.send(
        JSON.stringify({
          type: "sync",
          request_id: "sync-after-a-disconnect",
          runtime: runtimeB,
          recover_approvals: false,
        }),
      );
      await expect(syncPromise).resolves.toMatchObject({
        type: "sync_response",
        success: true,
        runtime: runtimeB,
      });
    } finally {
      closeClient(clientA);
      closeClient(clientB);
      await handle?.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 20_000);

  test("reaps one unresponsive client without disturbing a healthy peer", async () => {
    let handle: AppServerHandle | null = null;
    let staleClient: WebSocket | null = null;
    let healthyClient: WebSocket | null = null;
    try {
      let resolveReaped!: () => void;
      const reaped = new Promise<void>((resolve) => {
        resolveReaped = resolve;
      });
      handle = await startAppServer({
        listen: "ws://127.0.0.1:0",
        heartbeatIntervalMs: 25,
        pongTimeoutMs: 75,
        onLog: (message) => {
          if (message.includes("terminating unresponsive socket")) {
            resolveReaped();
          }
        },
        shouldRecordPong: (connectionOrdinal) => connectionOrdinal !== 0,
      });
      staleClient = new WebSocket(handle.duplexUrl);
      healthyClient = new WebSocket(handle.duplexUrl);
      const healthyMessages = collectMessages(healthyClient);
      await Promise.all([waitForOpen(staleClient), waitForOpen(healthyClient)]);

      await reaped;
      expect(healthyClient.readyState).toBe(WebSocket.OPEN);
      const infoPromise = waitForMessage(
        healthyMessages,
        (message) => message.request_id === "healthy-after-reap",
      );
      healthyClient.send(
        JSON.stringify({
          type: "app_server_info",
          request_id: "healthy-after-reap",
        }),
      );
      await expect(infoPromise).resolves.toMatchObject({
        type: "app_server_info_response",
        success: true,
      });
      await waitForClose(staleClient);
    } finally {
      closeClient(staleClient);
      closeClient(healthyClient);
      await handle?.close();
    }
  }, 20_000);
});
