import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import {
  runEnvironmentRoutedHeadlessTurn,
  startEnvironmentStatusStream,
} from "@/headless-environment-response";

function bindTestWebSocketServer(): WebSocketServer & { testPort: number } {
  const wss = new WebSocketServer({ port: 0 }) as WebSocketServer & {
    testPort: number;
  };
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("test websocket did not bind to a TCP port");
  }
  wss.testPort = address.port;
  return wss;
}

describe("environment status stream correlation", () => {
  test("does not emit unrelated same-conversation deltas", async () => {
    const wss = bindTestWebSocketServer();
    const messages: string[] = [];

    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "update_loop_status",
          runtime: { agent_id: "agent-env", conversation_id: "conv-env" },
          loop_status: {
            status: "WAITING_FOR_API_RESPONSE",
            active_run_ids: ["run-unrelated"],
            client_message_ids_by_run_id: {
              "run-unrelated": ["cm-unrelated"],
            },
            executing_tool_call_ids: [],
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "stream_delta",
          runtime: { agent_id: "agent-env", conversation_id: "conv-env" },
          delta: {
            type: "message",
            id: "msg-unrelated",
            message_type: "assistant_message",
            content: [{ type: "text", text: "wrong turn" }],
            run_id: "run-unrelated",
          },
        }),
      );
    });

    const stream = await startEnvironmentStatusStream({
      connectionId: "conn-env",
      agentId: "agent-env",
      conversationId: "conv-env",
      clientMessageId: "cm-requested",
      onMessage: (message) => messages.push(message.type),
      deps: {
        getApiRequestConfig: async () => ({
          baseUrl: `http://127.0.0.1:${wss.testPort}`,
          apiKey: "test-key",
        }),
      },
    });

    try {
      await stream.ready;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toEqual(["update_loop_status"]);
      expect(stream.getRunIds()).toEqual([]);
    } finally {
      stream.close();
      wss.close();
      await once(wss, "close");
    }
  });

  test("does not match missing-runtime status events", async () => {
    const wss = bindTestWebSocketServer();
    const messages: string[] = [];

    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "update_loop_status",
          loop_status: {
            status: "WAITING_FOR_API_RESPONSE",
            active_run_ids: ["run-requested"],
            client_message_ids_by_run_id: { "run-requested": ["cm-requested"] },
            executing_tool_call_ids: [],
          },
        }),
      );
      socket.send(
        JSON.stringify({
          type: "stream_delta",
          delta: {
            type: "message",
            id: "msg-missing-runtime",
            message_type: "assistant_message",
            content: [{ type: "text", text: "missing runtime" }],
            run_id: "run-requested",
          },
        }),
      );
    });

    const stream = await startEnvironmentStatusStream({
      connectionId: "conn-env",
      agentId: "agent-env",
      conversationId: "conv-env",
      clientMessageId: "cm-requested",
      onMessage: (message) => messages.push(message.type),
      deps: {
        getApiRequestConfig: async () => ({
          baseUrl: `http://127.0.0.1:${wss.testPort}`,
          apiKey: "test-key",
        }),
      },
    });

    try {
      await stream.ready;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toEqual([]);
      expect(stream.getRunIds()).toEqual([]);
    } finally {
      stream.close();
      wss.close();
      await once(wss, "close");
    }
  });

  test("filters run ids by client message correlation", async () => {
    const wss = bindTestWebSocketServer();
    const messages: string[] = [];

    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "update_loop_status",
          runtime: { agent_id: "agent-env", conversation_id: "conv-env" },
          loop_status: {
            status: "WAITING_FOR_API_RESPONSE",
            active_run_ids: ["run-requested", "run-unrelated"],
            client_message_ids_by_run_id: {
              "run-requested": ["cm-requested"],
              "run-unrelated": ["cm-unrelated"],
            },
            executing_tool_call_ids: [],
          },
        }),
      );
    });

    const stream = await startEnvironmentStatusStream({
      connectionId: "conn-env",
      agentId: "agent-env",
      conversationId: "conv-env",
      clientMessageId: "cm-requested",
      onMessage: (message) => messages.push(message.type),
      deps: {
        getApiRequestConfig: async () => ({
          baseUrl: `http://127.0.0.1:${wss.testPort}`,
          apiKey: "test-key",
        }),
      },
    });

    try {
      await stream.ready;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(messages).toEqual(["update_loop_status"]);
      expect(stream.getRunIds()).toEqual(["run-requested"]);
    } finally {
      stream.close();
      wss.close();
      await once(wss, "close");
    }
  });
});

describe("environment-routed headless turn cleanup", () => {
  test("closes the status stream when send fails", async () => {
    let closeCalls = 0;

    await expect(
      runEnvironmentRoutedHeadlessTurn({
        backend: {} as never,
        agentId: "agent-env",
        publicAgentId: "agent-public",
        conversationId: "conv-env",
        connectionId: "conn-env",
        content: [{ type: "text", text: "hello" }],
        outputFormat: "stream-json",
        includePartialMessages: false,
        sessionId: "session-1",
        environment: {},
        getStats: () => ({ totalWallMs: 0, totalApiMs: 0 }),
        writeFinalStdout: async () => {},
        writeWireMessage: () => {},
        deps: {
          startEnvironmentStatusStream: async () => ({
            ready: Promise.resolve(),
            close: () => {
              closeCalls += 1;
            },
            getRunIds: () => [],
          }),
          sendEnvironmentMessage: async () => {
            throw new Error("send failed");
          },
        },
      }),
    ).rejects.toThrow("send failed");

    expect(closeCalls).toBe(1);
  });

  test("closes the status stream when waiting fails", async () => {
    let closeCalls = 0;

    await expect(
      runEnvironmentRoutedHeadlessTurn({
        backend: {} as never,
        agentId: "agent-env",
        publicAgentId: "agent-public",
        conversationId: "conv-env",
        connectionId: "conn-env",
        content: [{ type: "text", text: "hello" }],
        outputFormat: "stream-json",
        includePartialMessages: false,
        sessionId: "session-1",
        environment: {},
        getStats: () => ({ totalWallMs: 0, totalApiMs: 0 }),
        writeFinalStdout: async () => {},
        writeWireMessage: () => {},
        deps: {
          startEnvironmentStatusStream: async () => ({
            ready: Promise.resolve(),
            close: () => {
              closeCalls += 1;
            },
            getRunIds: () => [],
          }),
          sendEnvironmentMessage: async () => ({
            success: true,
            message: "ok",
          }),
          waitForEnvironmentAssistantMessage: async () => {
            throw new Error("wait failed");
          },
        },
      }),
    ).rejects.toThrow("wait failed");

    expect(closeCalls).toBe(1);
  });
});
