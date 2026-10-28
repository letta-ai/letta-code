import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  clearExternalTools,
  executeTool,
  prepareToolExecutionContextForModel,
} from "@/tools/manager";
import type { ExternalToolCallRequestMessage } from "@/types/protocol_v2";
import {
  openListenerConnection,
  suspendListenerConnection,
} from "@/websocket/listener/connection";
import {
  handleExternalToolCallResponseCommand,
  registerRuntimeExternalTools,
} from "@/websocket/listener/external-tools";
import {
  createRuntime,
  startConnectedListenerRuntime,
  stopRuntime,
} from "@/websocket/listener/lifecycle";
import { setActiveRuntime } from "@/websocket/listener/runtime";
import type { LocalTransport } from "@/websocket/listener/transport";
import type {
  ListenerRuntime,
  StartListenerOptions,
} from "@/websocket/listener/types";

const CONNECTION_ID = "remote-client";
const RUNTIME_SCOPE = { agent_id: "agent-1", conversation_id: "conv-1" };

const options: StartListenerOptions = {
  connectionId: CONNECTION_ID,
  wsUrl: "wss://example.test/listener",
  deviceId: "test-device",
  connectionName: CONNECTION_ID,
  onConnected: () => {},
  onDisconnected: () => {},
  onError: () => {},
};

type FakeSocket = LocalTransport & {
  sent: ExternalToolCallRequestMessage[];
  open: boolean;
};

/** A socket whose peer answers requests only when `respond` is set. */
function createSocket(runtime: ListenerRuntime, respond: boolean): FakeSocket {
  const socket: FakeSocket = {
    kind: "local",
    bufferedAmount: 0,
    sent: [],
    open: true,
    isOpen: () => socket.open,
    send(data: string) {
      const request = JSON.parse(data) as ExternalToolCallRequestMessage;
      socket.sent.push(request);
      if (!respond) return;
      queueMicrotask(() => {
        handleExternalToolCallResponseCommand(runtime, CONNECTION_ID, {
          type: "external_tool_call_response",
          request_id: request.request_id,
          result: { content: [{ type: "text", text: "posted" }] },
        });
      });
    },
  };
  return socket;
}

async function connect(
  runtime: ListenerRuntime,
  socket: FakeSocket,
): Promise<void> {
  openListenerConnection({
    runtime,
    connectionId: CONNECTION_ID,
    writer: socket,
    options,
  });
  await startConnectedListenerRuntime(
    runtime,
    socket,
    options,
    async () => {},
    { startHeartbeat: false, startCronScheduler: false },
  );
  registerRuntimeExternalTools(runtime, CONNECTION_ID, RUNTIME_SCOPE, [
    {
      tools: [
        {
          name: "reply",
          description: "Reply in Slack",
          parameters: { type: "object", properties: {} },
        },
      ],
    },
  ]);
}

/** Mirrors the listener's transient (non-1008) close: suspend, keep the id. */
function dropSocket(runtime: ListenerRuntime, socket: FakeSocket): void {
  socket.open = false;
  suspendListenerConnection(runtime, CONNECTION_ID);
}

async function callReply(toolCallId: string) {
  const prepared = await prepareToolExecutionContextForModel(
    "anthropic/claude-sonnet-4",
    {
      clientToolAllowlist: ["reply"],
      runtimeContext: {
        agentId: RUNTIME_SCOPE.agent_id,
        conversationId: RUNTIME_SCOPE.conversation_id,
      },
    },
  );
  return executeTool(
    "reply",
    {},
    { toolContextId: prepared.contextId, toolCallId },
  );
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

describe("external tool calls across a websocket reconnect", () => {
  let runtime: ListenerRuntime;

  beforeEach(() => {
    clearExternalTools();
    runtime = createRuntime();
    runtime.processServicesStarted = true;
    setActiveRuntime(runtime);
  });

  afterEach(() => {
    stopRuntime(runtime, true);
    setActiveRuntime(null);
    clearExternalTools();
  });

  test("resends a request lost to a socket close once the new socket is ready", async () => {
    const first = createSocket(runtime, false);
    await connect(runtime, first);

    const call = callReply("call-reply");
    await waitFor(() => first.sent.length === 1);
    // Cloudflare 1001 lands right after the frame was written.
    dropSocket(runtime, first);

    const second = createSocket(runtime, true);
    await connect(runtime, second);
    const result = await call;

    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe("posted");
    expect(second.sent).toHaveLength(1);
    // Same request_id so the cloud gateway dedupes a request that did arrive.
    expect(second.sent[0]).toEqual(first.sent[0] as never);
    expect(runtime.pendingExternalToolCalls.size).toBe(0);
  });

  test("fails a call made while the socket is down immediately", async () => {
    const first = createSocket(runtime, true);
    await connect(runtime, first);
    dropSocket(runtime, first);

    const startedAt = Date.now();
    const result = await callReply("call-while-down");

    expect(result.status).toBe("error");
    expect(String(result.toolReturn)).toContain("was not sent");
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(first.sent).toHaveLength(0);
    expect(runtime.pendingExternalToolCalls.size).toBe(0);
  });

  test("a call answered on the same socket is sent exactly once", async () => {
    const socket = createSocket(runtime, true);
    await connect(runtime, socket);

    const result = await callReply("call-normal");

    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe("posted");
    expect(socket.sent).toHaveLength(1);
    expect(runtime.pendingExternalToolCalls.size).toBe(0);
  });
});
