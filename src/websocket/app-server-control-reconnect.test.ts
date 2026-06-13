import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { AgentCreateBody } from "@/backend";
import { __testSetBackend } from "@/backend";
import { LocalBackend } from "@/backend/local";
import { type AppServerHandle, startAppServer } from "@/websocket/app-server";

const TEST_TIMEOUT_MS = 8000;

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

function pageItems(page: unknown): unknown[] {
  if (Array.isArray(page)) return page;
  if (page && typeof page === "object") {
    const candidate = page as {
      getPaginatedItems?: () => unknown[];
      items?: unknown[];
    };
    if (typeof candidate.getPaginatedItems === "function") {
      return candidate.getPaginatedItems();
    }
    if (Array.isArray(candidate.items)) return candidate.items;
  }
  return [];
}

type RuntimeScope = { agent_id: string; conversation_id: string };

function startCreateAgentChat(control: WebSocket, requestId: string): void {
  control.send(
    JSON.stringify({
      type: "runtime_start",
      request_id: requestId,
      create_agent: {
        body: {
          name: "Reconnect Repro Agent",
          model: "anthropic/claude-sonnet-4-6",
        } as AgentCreateBody,
        pin_global: false,
      },
      create_conversation: { body: {} },
      recover_approvals: false,
    }),
  );
}

function startNewChat(
  control: WebSocket,
  requestId: string,
  agentId: string,
): void {
  control.send(
    JSON.stringify({
      type: "runtime_start",
      request_id: requestId,
      agent_id: agentId,
      create_conversation: { body: {} },
      recover_approvals: false,
    }),
  );
}

function sendFirstUserMessage(
  control: WebSocket,
  runtime: RuntimeScope,
  text: string,
): void {
  control.send(
    JSON.stringify({
      type: "input",
      runtime,
      payload: {
        kind: "create_message",
        messages: [
          {
            role: "user",
            content: text,
            client_message_id: `cm-${runtime.conversation_id}`,
          },
        ],
      },
    }),
  );
}

async function waitForConversationMessages(
  backend: LocalBackend,
  conversationId: string,
  agentId: string,
): Promise<unknown[]> {
  const deadline = Date.now() + TEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const items = pageItems(
      await backend.listConversationMessages(conversationId, {
        agent_id: agentId,
        order: "asc",
      } as never),
    );
    if (items.length > 0) return items;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return [];
}

afterEach(() => {
  __testSetBackend(null);
});

describe("app-server control reconnect", () => {
  // Regression: when the desktop reconnects its control socket while the
  // previous one is still registered (half-open after sleep/wake, or the
  // server has not yet observed the close), the new control socket must be
  // able to take over and drive a turn. Previously the second control
  // connection was hard-rejected, so every new chat after the reconnect
  // silently did nothing.
  test(
    "a reconnecting control socket takes over and runs a first-message turn",
    async () => {
      const storageDir = await mkdtemp(join(os.tmpdir(), "letta-reconnect-"));
      let handle: AppServerHandle | null = null;
      let control1: WebSocket | null = null;
      let control2: WebSocket | null = null;
      let stream1: WebSocket | null = null;
      let stream2: WebSocket | null = null;
      try {
        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
        stream1 = new WebSocket(handle.streamUrl);
        control1 = new WebSocket(handle.controlUrl);
        await Promise.all([waitForOpen(stream1), waitForOpen(control1)]);

        startCreateAgentChat(control1, "rs-1");
        const start1 = await waitForJsonMessage(
          control1,
          (m) => m.type === "runtime_start_response" && m.request_id === "rs-1",
        );
        expect(start1.success).toBe(true);
        const agentId = (start1.runtime as RuntimeScope).agent_id;

        // Reconnect WITHOUT the server having torn down control1 (control1 is
        // intentionally left open to model a half-open socket after sleep).
        stream2 = new WebSocket(handle.streamUrl);
        control2 = new WebSocket(handle.controlUrl);
        await Promise.all([waitForOpen(stream2), waitForOpen(control2)]);

        startNewChat(control2, "rs-2", agentId);
        const start2 = await waitForJsonMessage(
          control2,
          (m) => m.type === "runtime_start_response" && m.request_id === "rs-2",
        );
        expect(start2.success).toBe(true);
        const rt2 = start2.runtime as RuntimeScope;

        sendFirstUserMessage(control2, rt2, "hello after reconnect");
        const conv2 = await waitForConversationMessages(
          backend,
          rt2.conversation_id,
          agentId,
        );
        expect(conv2.length).toBeGreaterThan(0);
      } finally {
        closeClient(control1);
        closeClient(control2);
        closeClient(stream1);
        closeClient(stream2);
        await handle?.close();
        await rm(storageDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS + 4000,
  );

  // A graceful reconnect (old control socket fully closed first) must keep
  // working as before.
  test(
    "a new chat works after a graceful control reconnect (close then reopen)",
    async () => {
      const storageDir = await mkdtemp(join(os.tmpdir(), "letta-reconnect-g-"));
      let handle: AppServerHandle | null = null;
      let control1: WebSocket | null = null;
      let control2: WebSocket | null = null;
      let stream1: WebSocket | null = null;
      let stream2: WebSocket | null = null;
      try {
        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        __testSetBackend(backend);
        handle = await startAppServer({ listen: "ws://127.0.0.1:0" });
        stream1 = new WebSocket(handle.streamUrl);
        control1 = new WebSocket(handle.controlUrl);
        await Promise.all([waitForOpen(stream1), waitForOpen(control1)]);

        startCreateAgentChat(control1, "rs-1");
        const start1 = await waitForJsonMessage(
          control1,
          (m) => m.type === "runtime_start_response" && m.request_id === "rs-1",
        );
        const agentId = (start1.runtime as RuntimeScope).agent_id;

        const control1Closed = new Promise<void>((resolve) => {
          control1?.once("close", () => resolve());
        });
        control1.close();
        stream1.close();
        await control1Closed;
        await new Promise((resolve) => setTimeout(resolve, 100));

        stream2 = new WebSocket(handle.streamUrl);
        control2 = new WebSocket(handle.controlUrl);
        await Promise.all([waitForOpen(stream2), waitForOpen(control2)]);

        startNewChat(control2, "rs-2", agentId);
        const start2 = await waitForJsonMessage(
          control2,
          (m) => m.type === "runtime_start_response" && m.request_id === "rs-2",
        );
        expect(start2.success).toBe(true);
        const rt2 = start2.runtime as RuntimeScope;

        sendFirstUserMessage(control2, rt2, "hello after graceful reconnect");
        const conv2 = await waitForConversationMessages(
          backend,
          rt2.conversation_id,
          agentId,
        );
        expect(conv2.length).toBeGreaterThan(0);
      } finally {
        closeClient(control1);
        closeClient(control2);
        closeClient(stream1);
        closeClient(stream2);
        await handle?.close();
        await rm(storageDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS + 4000,
  );
});
